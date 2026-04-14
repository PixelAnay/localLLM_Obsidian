import { App, TFile } from 'obsidian';
import type { LlamaPluginSettings } from './types';

// ── Cosine similarity ──────────────────────────────────────────────────────────

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EmbeddingEntry {
  path: string;
  mtime: number;
  vector: number[];
}

export interface EmbeddingIndexData {
  version: number;
  model: string;
  entries: EmbeddingEntry[];
}

const EMBED_INDEX_VERSION = 1;

// ── EmbeddingIndex ────────────────────────────────────────────────────────────

export class EmbeddingIndex {
  private entries: EmbeddingEntry[] = [];
  private ready = false;
  private ollamaEndpoint = 'http://localhost:11434';
  private model = '';

  constructor(
    private app: App,
    private settings: LlamaPluginSettings
  ) {
    this.ollamaEndpoint = settings.ollamaEmbedEndpoint ?? 'http://localhost:11434';
    this.model = settings.embeddingModel ?? '';
  }

  get isReady(): boolean { return this.ready && this.model !== ''; }
  get entryCount(): number { return this.entries.length; }

  updateSettings(settings: LlamaPluginSettings): void {
    this.settings = settings;
    this.ollamaEndpoint = settings.ollamaEmbedEndpoint ?? 'http://localhost:11434';
    this.model = settings.embeddingModel ?? '';
  }

  /** Load saved index and incrementally update changed files */
  async build(
    savedData: EmbeddingIndexData | null,
    getContent: (path: string) => Promise<string | null>
  ): Promise<void> {
    if (!this.model) {
      // Embeddings disabled — clear index
      this.entries = [];
      this.ready = false;
      return;
    }

    const files = this.app.vault.getMarkdownFiles();

    // Restore valid entries from the saved index
    const saved: Map<string, EmbeddingEntry> = new Map();
    if (savedData && savedData.version === EMBED_INDEX_VERSION && savedData.model === this.model) {
      for (const e of savedData.entries) {
        saved.set(e.path, e);
      }
    }

    const result: EmbeddingEntry[] = [];

    for (const file of files) {
      const existing = saved.get(file.path);
      if (existing && existing.mtime === file.stat.mtime) {
        // Not changed — reuse
        result.push(existing);
      } else {
        // Changed or new — embed
        try {
          const content = await getContent(file.path);
          if (!content) continue;

          // Truncate to ~4000 chars (embedding models have short windows)
          const text = `${file.basename}\n\n${content}`.slice(0, 4000);
          const vector = await this.fetchEmbedding(text);
          if (vector) {
            result.push({ path: file.path, mtime: file.stat.mtime, vector });
          }
        } catch {
          // Silently skip failed embeds — fall through to keyword search
        }
      }
    }

    this.entries = result;
    this.ready = true;
  }

  /** Embed a single file (called after edits) */
  async embedFile(file: TFile, content: string): Promise<void> {
    if (!this.model) return;
    try {
      const text = `${file.basename}\n\n${content}`.slice(0, 4000);
      const vector = await this.fetchEmbedding(text);
      if (!vector) return;

      const existing = this.entries.findIndex(e => e.path === file.path);
      const entry: EmbeddingEntry = { path: file.path, mtime: file.stat.mtime, vector };
      if (existing >= 0) {
        this.entries[existing] = entry;
      } else {
        this.entries.push(entry);
      }
    } catch {
      // Silently ignore
    }
  }

  /** Remove a file entry */
  removeFile(path: string): void {
    this.entries = this.entries.filter(e => e.path !== path);
  }

  /** Rename a file's path */
  renameFile(oldPath: string, newPath: string, newMtime: number): void {
    const entry = this.entries.find(e => e.path === oldPath);
    if (entry) {
      entry.path = newPath;
      entry.mtime = newMtime;
    }
  }

  /**
   * Semantic similarity search.
   * Returns the top-N paths ranked by cosine similarity to the query.
   */
  async search(query: string, limit: number): Promise<string[]> {
    if (!this.isReady || this.entries.length === 0) return [];
    const qVec = await this.fetchEmbedding(query.slice(0, 1000));
    if (!qVec) return [];

    const scored = this.entries.map(e => ({
      path: e.path,
      score: cosine(qVec, e.vector),
    }));

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .filter(s => s.score > 0.25) // discard unrelated notes
      .map(s => s.path);
  }

  /** Serialise for persistence */
  toJSON(): EmbeddingIndexData {
    return {
      version: EMBED_INDEX_VERSION,
      model: this.model,
      entries: this.entries,
    };
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async fetchEmbedding(text: string): Promise<number[] | null> {
    if (!this.model) return null;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15_000);
    try {
      const base = this.ollamaEndpoint.replace(/\/$/, '');
      const resp = await fetch(`${base}/api/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model, prompt: text }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) return null;
      const data = await resp.json();
      return Array.isArray(data?.embedding) ? data.embedding : null;
    } catch {
      clearTimeout(timer);
      return null;
    }
  }
}
