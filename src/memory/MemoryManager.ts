/**
 * memory/MemoryManager.ts
 *
 * Manages the persistent memory file (memory.md) in the vault as a flat list.
 * Memory is structured as a flat bullet-point list under "# 💾 Stored Memories".
 * New facts are appended; old entries are trimmed when the file exceeds maxMemoryTokens.
 */

import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import { estimateTokens } from '../utils/tokenEstimator';

export interface MemoryEntry {
  id: string;
  fact: string;
  date: string; // ISO date string YYYY-MM-DD
}

export interface ParsedMemory {
  entries: MemoryEntry[];
  raw: string;
}

export class MemoryManager {
  private app: App;
  private memoryPath: string;
  private maxTokens: number;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(app: App, memoryPath: string, maxTokens: number) {
    this.app = app;
    this.memoryPath = memoryPath;
    this.maxTokens = maxTokens;
  }

  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const nextOp = this.writeQueue.then(op);
    this.writeQueue = nextOp.catch(() => {});
    return nextOp as Promise<T>;
  }

  updateConfig(memoryPath: string, maxTokens: number): void {
    this.memoryPath = memoryPath;
    this.maxTokens = maxTokens;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Load the full memory file content as a string for context injection. */
  async load(): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(this.memoryPath) as TFile | null;
    if (!file) return '';
    return this.app.vault.read(file);
  }

  /** Parse memory.md into a flat list of entries. */
  async parse(): Promise<ParsedMemory> {
    const raw = await this.load();
    return { entries: this.parseRaw(raw), raw };
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Append new facts to the memory file.
   * Creates the file (and parent folders) if it doesn't exist.
   * Includes a sanity check: the new entry list must never be shorter than
   * what was already on disk — guarding against silent data loss bugs.
   */
  async append(facts: Array<{ fact: string }>): Promise<void> {
    return this.enqueue(async () => {
      if (facts.length === 0) return;

      const parsed = await this.parse();
      const previousCount = parsed.entries.length;
      const today = new Date().toISOString().slice(0, 10);

      for (const { fact } of facts) {
        const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        parsed.entries.push({ id, fact, date: today });
      }

      // ── Sanity check: we should never write fewer entries than we read ──────
      if (parsed.entries.length < previousCount) {
        console.error(
          `[Engram] Memory append sanity check FAILED: would write ${parsed.entries.length} entries ` +
          `but disk has ${previousCount}. Aborting write to protect existing memories.`
        );
        return;
      }

      await this.writeBack(parsed.entries);
      await this.trimIfNeeded();
    });
  }

  /**
   * Delete a specific memory entry by its ID.
   */
  async forget(entryId: string): Promise<boolean> {
    return this.enqueue(async () => {
      const parsed = await this.parse();
      const before = parsed.entries.length;
      parsed.entries = parsed.entries.filter(e => e.id !== entryId);

      if (parsed.entries.length < before) {
        await this.writeBack(parsed.entries, false);
        return true;
      }
      return false;
    });
  }

  /** Clear all memory entries. Requires explicit force flag to prevent accidental wipes. */
  async clearAll(): Promise<void> {
    return this.enqueue(async () => {
      await this.writeBack([], true /* force empty */);
    });
  }

  // ── File management ───────────────────────────────────────────────────────

  async openInEditor(): Promise<void> {
    const file = await this.ensureFile();
    let leaf;
    try {
      leaf = this.app.workspace.getLeaf('tab');
    } catch {
      leaf = this.app.workspace.getLeaf(true);
    }
    await leaf.openFile(file, { active: true });
  }

  private async ensureParentFolder(filePath: string): Promise<void> {
    const lastSlash = filePath.lastIndexOf('/');
    if (lastSlash === -1) return;
    const folderPath = filePath.substring(0, lastSlash);
    if (!folderPath) return;

    const segments = folderPath.split('/');
    let currentPath = '';
    for (const segment of segments) {
      if (!segment) continue;
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const exists = this.app.vault.getAbstractFileByPath(currentPath);
      if (!exists) {
        try {
          await this.app.vault.createFolder(currentPath);
        } catch (e) {
          // Folder might have been created concurrently
        }
      }
    }
  }

  private async ensureFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(this.memoryPath);
    if (existing instanceof TFile) return existing;
    if (existing) {
      throw new Error(`The memory path "${this.memoryPath}" already exists as a folder. Please choose a different path in settings.`);
    }

    // Create parent folders recursively
    await this.ensureParentFolder(this.memoryPath);

    // Create with template
    const template = this.buildTemplate();
    return this.app.vault.create(this.memoryPath, template);
  }

  // ── Trim ──────────────────────────────────────────────────────────────────

  /**
   * If memory exceeds maxTokens, drop the oldest entries in the flat list
   * until we're under budget.
   */
  private async trimIfNeeded(): Promise<void> {
    const content = await this.load();
    if (estimateTokens(content) <= this.maxTokens) return;

    const entries = this.parseRaw(content);
    let trimmed = false;
    while (estimateTokens(this.buildContent(entries)) > this.maxTokens && entries.length > 0) {
      entries.shift(); // drop oldest entry from the start
      trimmed = true;
    }

    if (trimmed) await this.writeBack(entries, true);
  }

  // ── Serialisation ─────────────────────────────────────────────────────────

  private parseRaw(raw: string): MemoryEntry[] {
    const result: MemoryEntry[] = [];
    const lines = raw.split('\n');
    const lineRegex = /^-\s+\[(\d{4}-\d{2}-\d{2})\|([^\]]+)\]\s+(.+)$/;

    let currentEntry: MemoryEntry | null = null;

    for (const line of lines) {
      const match = lineRegex.exec(line.trim());
      if (match) {
        if (currentEntry) {
          result.push(currentEntry);
        }
        currentEntry = {
          date: match[1],
          id: match[2],
          fact: match[3],
        };
      } else if (currentEntry && line.trim() !== '' && !line.trim().startsWith('-')) {
        // Multi-line continuation: append this line to the current entry (M-13)
        currentEntry.fact += '\n' + line.trim();
      }
    }

    if (currentEntry) {
      result.push(currentEntry);
    }

    return result;
  }

  private buildContent(entries: MemoryEntry[]): string {
    const lines: string[] = [
      '---',
      `last_updated: ${new Date().toISOString().slice(0, 10)}`,
      '---',
      '',
      '# 💾 Stored Memories',
      '',
    ];

    if (entries.length === 0) {
      lines.push('');
    } else {
      for (const e of entries) {
        // Indent continuation lines with 2 spaces for beautiful markdown lists (M-13)
        const parts = e.fact.split('\n');
        const formattedFact = parts.map((line, idx) => idx === 0 ? line : `  ${line}`).join('\n');
        lines.push(`- [${e.date}|${e.id}] ${formattedFact}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  private buildTemplate(): string {
    return this.buildContent([]);
  }

  /**
   * Write entries back to disk.
   *
   * @param entries  The entries to persist.
   * @param force    Must be `true` to allow writing an empty array.
   *                 This prevents accidental full-wipes from code bugs.
   */
  private async writeBack(entries: MemoryEntry[], force = false): Promise<void> {
    // ── Empty-array guard ────────────────────────────────────────────────────
    if (entries.length === 0 && !force) {
      console.error(
        '[Engram] writeBack called with empty entries list without force=true. ' +
        'Aborting to protect existing memories. Call clearAll() to intentionally wipe.'
      );
      return;
    }

    const content = this.buildContent(entries);
    const file = await this.ensureFile();

    // ── Pre-write backup ─────────────────────────────────────────────────────
    // Save a .bak copy of the current content so the user can manually
    // recover it if something goes wrong.
    try {
      const current = await this.app.vault.read(file);
      if (current && current.trim().length > 0) {
        const bakPath = this.memoryPath.replace(/\.md$/, '') + '.md.bak';
        const bakFile = this.app.vault.getAbstractFileByPath(bakPath) as import('obsidian').TFile | null;
        if (bakFile) {
          await this.app.vault.modify(bakFile, current);
        } else {
          await this.ensureParentFolder(bakPath);
          await this.app.vault.create(bakPath, current);
        }
      }
    } catch (err) {
      // Backup failure must never block the main write
      console.warn('[Engram] Failed to create memory backup:', err);
    }

    await this.app.vault.modify(file, content);
  }
}
