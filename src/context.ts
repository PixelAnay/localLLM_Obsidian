import type { VaultIndexer } from './indexer';
import type { ChatMessage, LlamaPluginSettings } from './types';
import { TOOL_INJECTION_PROMPT } from './tools';

// Rough token estimator: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextBuilder {
  constructor(private indexer: VaultIndexer, private settings: LlamaPluginSettings) {}

  updateSettings(settings: LlamaPluginSettings): void {
    this.settings = settings;
  }

  /**
   * Build the full system message, including:
   * - Role description + today's date
   * - Vault map (all note paths + tags)
   * - Auto-injected top-N relevant notes (full content)
   * - Tool injection prompt (if mode = prompt_injection)
   * - User-supplied extra instructions
   */
  async buildSystemMessage(userMessage: string): Promise<string> {
    const budget = this.settings.contextWindowTokens;

    const parts: string[] = [];

    // 1. Base role prompt
    const today = new Date().toLocaleDateString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
    parts.push(
      `You are a helpful AI assistant embedded in Obsidian, a personal knowledge management app.\n` +
      `Today is ${today}.\n\n` +
      `You have full general knowledge and should answer questions normally, just like any capable AI assistant.\n` +
      `In addition, you have special tools that give you access to the user's Obsidian vault (their Markdown notes).\n` +
      `Use vault tools when: the user asks about their notes, wants to search/edit/create notes, or asks something that would benefit from checking their personal knowledge base.\n` +
      `When the user asks to open a note (or multiple notes), call the open_note tool instead of only listing paths in text.\n` +
      `For requests like open every note about a topic, first search for matching notes, then call open_note with every relevant path.\n` +
      `Do NOT use vault tools for general knowledge questions (history, science, language, coding, etc.) — just answer those directly.\n` +
      `Be concise and helpful. When you do reference vault content, cite the note path.`
    );

    // 2. Tool injection prompt (if needed)
    if (this.settings.toolCallingMode === 'prompt_injection') {
      parts.push('\n' + TOOL_INJECTION_PROMPT);
    }

    // 3. Extra system prompt from user
    if (this.settings.systemPromptExtra.trim()) {
      parts.push('\n' + this.settings.systemPromptExtra.trim());
    }

    // 4. Vault map (all paths + tags)
    const vaultMap = this.indexer.getVaultMap();
    const vaultMapSection =
      `\n## Vault Map (${this.indexer.noteCount} notes)\n` +
      `The following notes exist in the vault (excluded: ${this.indexer.excludedCount}):\n` +
      vaultMap;

    const baseTokens = estimateTokens(parts.join('\n') + vaultMapSection);
    const remainingBudget = budget - baseTokens - 200; // leave 200 token buffer for tool results

    // 5. Auto-inject top-N relevant notes
    const injectedNotes: string[] = [];
    if (this.settings.autoInjectNotes > 0 && remainingBudget > 200 && userMessage.trim()) {
      const topNotes = this.indexer.getTopNotes(userMessage, this.settings.autoInjectNotes);
      let usedTokens = 0;

      for (const meta of topNotes) {
        const content = await this.indexer.readNote(meta.path);
        if (!content) continue;

        const noteSection = `\n### Note: ${meta.path}\n${content}`;
        const noteTokens = estimateTokens(noteSection);

        if (usedTokens + noteTokens > remainingBudget) break;

        injectedNotes.push(noteSection);
        usedTokens += noteTokens;
      }
    }

    // Assemble
    let systemPrompt = parts.join('\n') + vaultMapSection;

    if (injectedNotes.length > 0) {
      systemPrompt +=
        `\n\n## Pre-loaded Notes (auto-selected as relevant to the current query)\n` +
        injectedNotes.join('\n\n');
    }

    return systemPrompt;
  }

  /**
   * Prepend a fresh system message to the conversation history.
   * Replaces any existing system message.
   */
  async prependSystemMessage(
    messages: ChatMessage[],
    userMessage: string
  ): Promise<ChatMessage[]> {
    const systemContent = await this.buildSystemMessage(userMessage);
    const withoutSystem = messages.filter(m => m.role !== 'system');
    return [{ role: 'system', content: systemContent }, ...withoutSystem];
  }
}
