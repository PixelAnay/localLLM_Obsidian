import type { ChatMessage, StreamChunk, ToolCall, LlamaPluginSettings } from './types';
import type { ToolExecutor } from './tools';
import { TOOL_DEFINITIONS, TOOL_INJECTION_PROMPT } from './tools';

// ─── Types for raw API responses ──────────────────────────────────────────────

interface DeltaToolCall {
  index: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: DeltaToolCall[];
}

interface StreamChoice {
  delta: StreamDelta;
  finish_reason: string | null;
}

interface StreamChunkRaw {
  choices: StreamChoice[];
}

// ─── LLM Client ──────────────────────────────────────────────────────────────

export class LLMClient {
  private abortController: AbortController | null = null;

  constructor(private settings: LlamaPluginSettings) {}

  updateSettings(settings: LlamaPluginSettings): void {
    this.settings = settings;
  }

  /** Check if llama.cpp is reachable. Returns model name or throws. */
  async healthCheck(): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(`${this.settings.endpoint}/v1/models`, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { data?: Array<{ id: string }> };
      return data?.data?.[0]?.id ?? 'unknown';
    } finally {
      clearTimeout(timer);
    }
  }

  /** Abort the current streaming request */
  abort(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  /**
   * Main entry point: run a full turn (possibly multiple tool calls).
   * Yields StreamChunk events to the caller via the onChunk callback.
   */
  async *runTurn(
    messages: ChatMessage[],
    toolExecutor: ToolExecutor,
    onChunk: (chunk: StreamChunk) => void
  ): AsyncGenerator<ChatMessage[]> {
    const workingMessages: ChatMessage[] = [...messages];
    let depth = 0;

    while (depth < this.settings.maxToolCallDepth) {
      this.abortController = new AbortController();

      const useTools =
        this.settings.toolCallingMode === 'native' ||
        this.settings.toolCallingMode === 'prompt_injection';

      let assistantText = '';
      let toolCalls: ToolCall[] = [];
      let finishReason: string | null = null;

      // ── Build request body ───────────────────────────────────────────────
      const body: Record<string, unknown> = {
        model: this.settings.model || undefined,
        messages: workingMessages,
        stream: true,
        temperature: this.settings.temperature,
      };

      if (this.settings.toolCallingMode === 'native') {
        body.tools = TOOL_DEFINITIONS;
        body.tool_choice = 'auto';
      }

      // ── Stream the response ──────────────────────────────────────────────
      let response: Response;
      try {
        response = await fetch(`${this.settings.endpoint}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: this.abortController.signal,
        });
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          onChunk({ type: 'done' });
          return;
        }
        onChunk({
          type: 'error',
          error: `Connection failed: ${(e as Error).message}. Is llama.cpp running at ${this.settings.endpoint}?`,
        });
        return;
      }

      if (!response.ok) {
        const text = await response.text();
        onChunk({ type: 'error', error: `Server error ${response.status}: ${text}` });
        return;
      }

      if (!response.body) {
        onChunk({ type: 'error', error: 'No response body from server' });
        return;
      }

      // ── Parse SSE stream ─────────────────────────────────────────────────
      const partialToolCalls: Record<number, { id: string; name: string; args: string }> = {};

      try {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith('data:')) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') { finishReason = finishReason ?? 'stop'; break; }

            let chunk: StreamChunkRaw;
            try { chunk = JSON.parse(payload); } catch { continue; }

            const choice = chunk.choices?.[0];
            if (!choice) continue;

            if (choice.finish_reason) finishReason = choice.finish_reason;

            const delta = choice.delta;

            // Token content
            if (delta.content) {
              assistantText += delta.content;
              onChunk({ type: 'token', content: delta.content });
            }

            // Native tool calls (assembled from streaming chunks)
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                if (!partialToolCalls[tc.index]) {
                  partialToolCalls[tc.index] = { id: tc.id ?? '', name: '', args: '' };
                }
                if (tc.function?.name) partialToolCalls[tc.index].name += tc.function.name;
                if (tc.function?.arguments) partialToolCalls[tc.index].args += tc.function.arguments;
                if (tc.id) partialToolCalls[tc.index].id = tc.id;
              }
            }
          }
        }
      } catch (e) {
        if ((e as Error).name === 'AbortError') {
          onChunk({ type: 'done' });
          return;
        }
        throw e;
      }

      // Assemble tool calls from partials
      toolCalls = Object.values(partialToolCalls).map(tc => ({
        id: tc.id || `call_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.args },
      }));

      // ── Prompt-injection fallback: parse <tool_call> blocks ──────────────
      if (this.settings.toolCallingMode === 'prompt_injection' && assistantText && toolCalls.length === 0) {
        const injectionCalls = parseInjectionToolCalls(assistantText);
        if (injectionCalls.length > 0) {
          toolCalls = injectionCalls;
          // Strip the tool_call block from the visible text
          assistantText = assistantText.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
          finishReason = 'tool_calls';
        }
      }

      // ── Append assistant message to history ──────────────────────────────
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: assistantText || null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      };
      workingMessages.push(assistantMsg);

      // ── No tool calls → we're done ────────────────────────────────────────
      if (toolCalls.length === 0 || finishReason !== 'tool_calls') {
        onChunk({ type: 'done' });
        yield workingMessages;
        return;
      }

      // ── Execute each tool call ────────────────────────────────────────────
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const toolArgs = tc.function.arguments;

        onChunk({ type: 'tool_start', toolName, toolArgs });

        const result = await toolExecutor.execute(toolName, toolArgs);

        onChunk({ type: 'tool_end', toolName, toolResult: result });

        workingMessages.push({
          role: 'tool',
          tool_call_id: tc.id,
          name: toolName,
          content: result,
        });
      }

      depth++;
    }

    // Exceeded max tool call depth
    onChunk({
      type: 'error',
      error: `Max tool call depth (${this.settings.maxToolCallDepth}) exceeded. Stopping.`,
    });
    onChunk({ type: 'done' });
    yield workingMessages;
  }
}

// ─── Prompt-injection parser ───────────────────────────────────────────────

function parseInjectionToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const regex = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]) as { name: string; arguments: Record<string, unknown> };
      if (parsed.name) {
        calls.push({
          id: `inj_${Date.now()}_${Math.random().toString(36).slice(2)}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments ?? {}),
          },
        });
      }
    } catch {
      // Skip malformed tool call blocks
    }
  }

  return calls;
}
