import { App, TFile, Notice } from 'obsidian';
import type { VaultIndexer } from './indexer';
import type { LlamaPluginSettings } from './types';

// ─── Tool Definitions (OpenAI schema) ────────────────────────────────────────

export const TOOL_DEFINITIONS = [
  {
    type: 'function',
    function: {
      name: 'search_vault',
      description:
        'Search notes in the Obsidian vault by keyword, title, or tags. Returns a list of matching note paths with metadata.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search terms (matched against title, tags, and frontmatter)',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional: filter results to notes containing any of these tags (without #)',
          },
          full_text: {
            type: 'boolean',
            description:
              'If true, also searches inside file content (slower but finds more results)',
          },
          limit: {
            type: 'number',
            description: 'Maximum number of results to return (default 10)',
          },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description: 'Read the full Markdown content of a note by its vault path.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'The vault-relative path to the note, e.g. "Projects/MyNote.md"',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_folder',
      description: 'List all notes inside a vault folder (and its sub-folders).',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Folder path, e.g. "Projects" or "" for vault root',
          },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_to_note',
      description: 'Append text to the end of an existing note. This is the safest way to add content.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path to the note' },
          content: { type: 'string', description: 'Text to append (Markdown)' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_note',
      description:
        'Edit a note by replacing a specific block of text (surgical) or overwriting the entire content (full_overwrite). Prefer replace_block for precision.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Vault-relative path to the note' },
          mode: {
            type: 'string',
            enum: ['replace_block', 'full_overwrite'],
            description:
              '"replace_block" finds old_text and replaces it with new_text. "full_overwrite" replaces the entire note content with new_content.',
          },
          old_text: {
            type: 'string',
            description: 'The exact text to find and replace (required for replace_block mode)',
          },
          new_text: {
            type: 'string',
            description: 'The replacement text (required for replace_block mode)',
          },
          new_content: {
            type: 'string',
            description: 'The full new content for the note (required for full_overwrite mode)',
          },
        },
        required: ['path', 'mode'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_note',
      description: 'Create a new note at the given path with specified content.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative path including filename, e.g. "Projects/NewNote.md"',
          },
          content: { type: 'string', description: 'Initial Markdown content of the new note' },
          overwrite: {
            type: 'boolean',
            description: 'If true, overwrite if the file already exists. Default false.',
          },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_note',
      description:
        'Open one or more vault notes in new Obsidian editor tabs. Use this when the user explicitly asks to open or view a note.',
      parameters: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'List of vault-relative note paths to open, e.g. ["Projects/MyNote.md", "Journal/2024-01-01.md"]',
          },
        },
        required: ['paths'],
      },
    },
  },
] as const;

// ─── Prompt-Injection Template (fallback mode) ────────────────────────────────

export const TOOL_INJECTION_PROMPT = `
You have access to the following vault tools. When you need to use a tool, output ONLY a JSON block wrapped in <tool_call> tags, then stop and wait for the result. Do not output anything else on the same line.

Available tools:
- search_vault(query, tags?, full_text?, limit?): Search notes by keyword/tag
- read_note(path): Read full content of a note
- list_folder(path): List notes in a folder
- append_to_note(path, content): Append text to a note
- edit_note(path, mode, old_text?, new_text?, new_content?): Edit a note
- create_note(path, content, overwrite?): Create a new note
- open_note(paths): Open one or more notes in editor tabs

Format:
<tool_call>
{"name": "tool_name", "arguments": {"arg": "value"}}
</tool_call>
`.trim();

// ─── Undo History ────────────────────────────────────────────────────────────

export interface UndoEntry {
  path: string;
  previousContent: string;
  description: string;
  timestamp: number;
}

// ─── Tool Executor ────────────────────────────────────────────────────────────

export class ToolExecutor {
  private undoStack: UndoEntry[] = [];

  // Callback so ChatView can open notes without a circular dependency
  onOpenNotes?: (paths: string[]) => void;

  constructor(
    private app: App,
    private indexer: VaultIndexer,
    private settings: LlamaPluginSettings
  ) {}

  updateSettings(settings: LlamaPluginSettings): void {
    this.settings = settings;
  }

  /** Execute a tool call and return the result as a string */
  async execute(name: string, argsJson: string): Promise<string> {
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(argsJson);
    } catch {
      return `Error: Invalid JSON arguments: ${argsJson}`;
    }

    try {
      switch (name) {
        case 'search_vault':   return await this.toolSearchVault(args);
        case 'read_note':      return await this.toolReadNote(args);
        case 'list_folder':    return await this.toolListFolder(args);
        case 'append_to_note': return await this.toolAppendToNote(args);
        case 'edit_note':      return await this.toolEditNote(args);
        case 'create_note':    return await this.toolCreateNote(args);
        case 'open_note':      return await this.toolOpenNote(args);
        default:               return `Error: Unknown tool "${name}"`;
      }
    } catch (e) {
      return `Error: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  get undoHistory(): UndoEntry[] {
    return [...this.undoStack];
  }

  async undoLast(): Promise<string | null> {
    const entry = this.undoStack.pop();
    if (!entry) return null;

    const file = this.app.vault.getAbstractFileByPath(entry.path);
    if (file instanceof TFile) {
      await this.app.vault.modify(file, entry.previousContent);
      await this.indexer.updateFile(file);
      return entry.path;
    }
    return null;
  }

  // ── Tools ─────────────────────────────────────────────────────────────────

  private async toolSearchVault(args: Record<string, unknown>): Promise<string> {
    const query = String(args.query ?? '');
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : undefined;
    const fullText = Boolean(args.full_text);
    const limit = typeof args.limit === 'number' ? Math.min(args.limit, 50) : 10;

    const metaResults = this.indexer.search(query, tags, limit);

    if (fullText && query) {
      const ftResults = await this.indexer.fullTextSearch(query, limit);
      const existing = new Set(metaResults.map(r => r.path));
      for (const r of ftResults) {
        if (!existing.has(r.path)) metaResults.push(r);
      }
    }

    if (metaResults.length === 0) return 'No notes found matching your search.';

    const lines = metaResults.slice(0, limit).map(r => {
      const tags = r.tags.length > 0 ? ` [${r.tags.join(', ')}]` : '';
      const snippet = r.snippet ? `\n  > ${r.snippet}` : '';
      return `- ${r.path}${tags}${snippet}`;
    });

    return `Found ${metaResults.length} notes:\n${lines.join('\n')}`;
  }

  private async toolReadNote(args: Record<string, unknown>): Promise<string> {
    const path = this.validatePath(args.path);
    if (!path) return 'Error: Invalid or missing path';

    const content = await this.indexer.readNote(path);
    if (content === null) return `Error: Note not found or excluded: ${path}`;

    return `Content of "${path}":\n\n${content}`;
  }

  private toolListFolder(args: Record<string, unknown>): string {
    const path = String(args.path ?? '').trim();
    const notes = this.indexer.listFolder(path);

    if (notes.length === 0) return `No notes found in folder: "${path || 'vault root'}"`;

    const lines = notes.map(m => {
      const tags = m.tags.length > 0 ? ` [${m.tags.join(', ')}]` : '';
      return `- ${m.path}${tags}`;
    });
    return `${notes.length} notes in "${path || 'vault root'}":\n${lines.join('\n')}`;
  }

  private async toolAppendToNote(args: Record<string, unknown>): Promise<string> {
    if (this.settings.editPermission === 'read_only') {
      return 'Error: Edit permission is set to read-only. Change it in plugin settings.';
    }

    const path = this.validatePath(args.path);
    if (!path) return 'Error: Invalid or missing path';
    const content = String(args.content ?? '');
    if (!content.trim()) return 'Error: Content to append is empty';

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return `Error: Note not found: ${path}`;

    const existing = await this.app.vault.read(file);
    this.pushUndo(path, existing, `append to ${path}`);

    const separator = existing.endsWith('\n') ? '\n' : '\n\n';
    await this.app.vault.modify(file, existing + separator + content);
    await this.indexer.updateFile(file);

    return `✅ Appended ${content.length} chars to "${path}"`;
  }

  private async toolEditNote(args: Record<string, unknown>): Promise<string> {
    if (this.settings.editPermission === 'read_only') {
      return 'Error: Edit permission is set to read-only. Change it in plugin settings.';
    }

    const path = this.validatePath(args.path);
    if (!path) return 'Error: Invalid or missing path';
    const mode = String(args.mode ?? '');

    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return `Error: Note not found: ${path}`;

    const existing = await this.app.vault.read(file);
    this.pushUndo(path, existing, `edit ${path} (${mode})`);

    if (mode === 'replace_block') {
      const oldText = String(args.old_text ?? '');
      const newText = String(args.new_text ?? '');
      if (!oldText) return 'Error: old_text is required for replace_block mode';
      if (!existing.includes(oldText)) {
        return `Error: Could not find the text to replace. Make sure it matches exactly (including whitespace):\n\`\`\`\n${oldText}\n\`\`\``;
      }
      const updated = existing.replace(oldText, newText);
      await this.app.vault.modify(file, updated);
      await this.indexer.updateFile(file);
      return `✅ Replaced block in "${path}" (${Math.abs(newText.length - oldText.length)} chars delta)`;
    }

    if (mode === 'full_overwrite') {
      if (this.settings.editPermission !== 'full_edit') {
        return 'Error: Full overwrite requires "full_edit" permission in plugin settings.';
      }
      const newContent = String(args.new_content ?? '');
      await this.app.vault.modify(file, newContent);
      await this.indexer.updateFile(file);
      return `✅ Overwrote "${path}" with ${newContent.length} chars`;
    }

    return `Error: Unknown edit mode "${mode}". Use "replace_block" or "full_overwrite".`;
  }

  private async toolCreateNote(args: Record<string, unknown>): Promise<string> {
    if (this.settings.editPermission === 'read_only') {
      return 'Error: Edit permission is set to read-only. Change it in plugin settings.';
    }
    if (this.settings.editPermission === 'read_append') {
      return 'Error: Creating notes requires "full_edit" permission in plugin settings.';
    }

    const path = this.validatePath(args.path);
    if (!path) return 'Error: Invalid or missing path';
    const content = String(args.content ?? '');
    const overwrite = Boolean(args.overwrite ?? false);

    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && !overwrite) {
      return `Error: Note already exists at "${path}". Set overwrite: true to replace it.`;
    }

    if (existing instanceof TFile && overwrite) {
      const old = await this.app.vault.read(existing);
      this.pushUndo(path, old, `create/overwrite ${path}`);
      await this.app.vault.modify(existing, content);
    } else {
      // Ensure parent folders exist
      const folder = path.contains('/') ? path.substring(0, path.lastIndexOf('/')) : '';
      if (folder) {
        const folderExists = this.app.vault.getAbstractFileByPath(folder);
        if (!folderExists) {
          await this.app.vault.createFolder(folder);
        }
      }
      await this.app.vault.create(path, content);
    }

    const file = this.app.vault.getAbstractFileByPath(path) as TFile;
    if (file) await this.indexer.updateFile(file);

    return `✅ Created "${path}" (${content.length} chars)`;
  }

  private async toolOpenNote(args: Record<string, unknown>): Promise<string> {
    const rawPaths = Array.isArray(args.paths) ? args.paths.map(String) : [];
    if (rawPaths.length === 0) return 'Error: No paths provided';

    const opened: string[] = [];
    const missing: string[] = [];

    for (const p of rawPaths) {
      const validated = this.validatePath(p);
      if (!validated) { missing.push(p); continue; }
      const file = this.app.vault.getAbstractFileByPath(validated);
      if (!(file instanceof TFile)) { missing.push(p); continue; }
      opened.push(validated);
    }

    if (opened.length === 0) {
      return `Error: None of the specified notes were found: ${rawPaths.join(', ')}`;
    }

    // Delegate actual UI opening to ChatView via callback
    if (this.onOpenNotes) {
      this.onOpenNotes(opened);
    }

    const report = opened.map(p => `"${p}"`).join(', ');
    const missingReport = missing.length > 0 ? ` (not found: ${missing.map(p => `"${p}"`).join(', ')})` : '';
    return `✅ Opened ${opened.length} note(s): ${report}${missingReport}`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private validatePath(raw: unknown): string | null {
    if (typeof raw !== 'string' || !raw.trim()) return null;
    // Prevent path traversal
    const normalized = raw.replace(/\\/g, '/').replace(/\.\.\/|\.\.$/g, '').trim();
    return normalized || null;
  }

  private pushUndo(path: string, previousContent: string, description: string): void {
    this.undoStack.push({ path, previousContent, description, timestamp: Date.now() });
    // Keep only last 20 undo entries
    if (this.undoStack.length > 20) this.undoStack.shift();
  }
}
