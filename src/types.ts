// ─── LLM Message Types ──────────────────────────────────────────────────────

export interface MessageContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  [key: string]: any;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | MessageContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  attachments?: { name: string; type: string; dataUrl: string }[];
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  name: string;
  content: string;
}

// ─── Vault Index Types ───────────────────────────────────────────────────────

export interface NoteMetadata {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  mtime: number;
  wordCount: number;
  size: number;
}

export interface VaultIndex {
  version: number;
  buildTime: number;
  notes: Record<string, NoteMetadata>;
}

// ─── Plugin Settings ─────────────────────────────────────────────────────────

export type EditPermission = 'read_only' | 'read_append' | 'full_edit';
export type ToolCallingMode = 'native' | 'prompt_injection' | 'disabled';
export type ChatState = 'idle' | 'streaming' | 'tool_pending' | 'tool_executing' | 'error';

export interface LlamaPluginSettings {
  endpoint: string;
  model: string;
  systemPromptExtra: string;
  contextWindowTokens: number;
  autoInjectNotes: number;
  editPermission: EditPermission;
  toolCallingMode: ToolCallingMode;
  excludePatterns: string[];
  maxToolCallDepth: number;
  showDiffPreview: boolean;
  diffPreviewThreshold: number;
  temperature: number;
  /** Ollama base URL used for embeddings (may differ from LLM endpoint) */
  ollamaEmbedEndpoint: string;
  /** Ollama model name to use for embeddings, e.g. "nomic-embed-text". Leave blank to disable. */
  embeddingModel: string;
}

// ─── Persisted Chat History Types ───────────────────────────────────────────

export interface ChatSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

// ─── UI Event Types ───────────────────────────────────────────────────────────

export interface StreamChunk {
  type: 'token' | 'tool_start' | 'tool_end' | 'error' | 'done';
  content?: string;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  error?: string;
}

export interface SearchResult {
  path: string;
  title: string;
  tags: string[];
  snippet?: string;
  score: number;
}
