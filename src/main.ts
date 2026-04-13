import { Plugin, WorkspaceLeaf, TFile, Platform, Notice } from 'obsidian';
import { LLAMA_CHAT_VIEW_TYPE, ChatView } from './ChatView';
import { VaultIndexer } from './indexer';
import { LLMClient } from './llm';
import { ToolExecutor } from './tools';
import { ContextBuilder } from './context';
import { LlamaSettingTab, DEFAULT_SETTINGS } from './settings';
import type { LlamaPluginSettings, VaultIndex } from './types';

export default class LlamaPlugin extends Plugin {
  settings!: LlamaPluginSettings;
  indexer!: VaultIndexer;
  llmClient!: LLMClient;
  toolExecutor!: ToolExecutor;
  contextBuilder!: ContextBuilder;

  private indexRebuildTimer: ReturnType<typeof setTimeout> | null = null;

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async onload(): Promise<void> {
    // Desktop-only guard
    if (Platform.isMobile) {
      this.addRibbonIcon('message-circle', 'LLAMA Chat (desktop only)', () => {
        new Notice('LLAMA Chat requires a desktop environment to reach your local LLM.');
      });
      return;
    }

    await this.loadSettings();
    this.initServices();

    // Register sidebar view
    this.registerView(LLAMA_CHAT_VIEW_TYPE, leaf => new ChatView(leaf, this));

    // Ribbon icon
    this.addRibbonIcon('message-circle', 'Open LLAMA Chat', () => this.activateView());

    // Command palette
    this.addCommand({
      id: 'open-llama-chat',
      name: 'Open LLAMA Chat sidebar',
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: 'llama-reindex-vault',
      name: 'LLAMA Chat: Re-index vault',
      callback: () => this.rebuildIndex(),
    });

    // Settings tab
    this.addSettingTab(new LlamaSettingTab(this.app, this));

    // Build vault index (non-blocking)
    this.buildIndexInBackground();

    // Watch vault for changes
    this.registerVaultEvents();
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(LLAMA_CHAT_VIEW_TYPE);
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
  }

  // ── Settings ───────────────────────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data?.settings ?? {});
  }

  async saveSettings(): Promise<void> {
    const existing = (await this.loadData()) ?? {};
    await this.saveData({ ...existing, settings: this.settings });

    // Propagate settings changes to services
    if (this.llmClient) this.llmClient.updateSettings(this.settings);
    if (this.toolExecutor) this.toolExecutor.updateSettings(this.settings);
    if (this.contextBuilder) this.contextBuilder.updateSettings(this.settings);
    if (this.indexer) this.indexer.updateSettings(this.settings);
  }

  // ── Services ───────────────────────────────────────────────────────────────

  private initServices(): void {
    this.indexer = new VaultIndexer(this.app, this.settings);
    this.llmClient = new LLMClient(this.settings);
    this.toolExecutor = new ToolExecutor(this.app, this.indexer, this.settings);
    this.contextBuilder = new ContextBuilder(this.indexer, this.settings);
  }

  // ── Vault Indexing ─────────────────────────────────────────────────────────

  private async buildIndexInBackground(): Promise<void> {
    const data = await this.loadData();
    const savedIndex: VaultIndex | null = data?.index ?? null;

    try {
      await this.indexer.build(savedIndex);
      await this.persistIndex();
      console.log(`[LLAMA Chat] Vault indexed: ${this.indexer.noteCount} notes`);
    } catch (e) {
      console.error('[LLAMA Chat] Indexing error:', e);
    }
  }

  private async persistIndex(): Promise<void> {
    const existing = (await this.loadData()) ?? {};
    await this.saveData({ ...existing, index: this.indexer.getSerializable() });
  }

  private async rebuildIndex(): Promise<void> {
    new Notice('🦙 Re-indexing vault…');
    await this.indexer.build(null);
    await this.persistIndex();
    new Notice(`🦙 Vault indexed: ${this.indexer.noteCount} notes`);
  }

  // ── Vault Event Handlers ───────────────────────────────────────────────────

  private registerVaultEvents(): void {
    this.registerEvent(
      this.app.vault.on('create', async file => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('modify', async file => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.updateFile(file);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('delete', file => {
        if (file instanceof TFile && file.extension === 'md') {
          this.indexer.removeFile(file.path);
          this.schedulePersist();
        }
      })
    );

    this.registerEvent(
      this.app.vault.on('rename', async (file, oldPath) => {
        if (file instanceof TFile && file.extension === 'md') {
          await this.indexer.renameFile(file, oldPath);
          this.schedulePersist();
        }
      })
    );
  }

  /** Debounce index persistence to avoid writing on every keystroke */
  private schedulePersist(): void {
    if (this.indexRebuildTimer) clearTimeout(this.indexRebuildTimer);
    this.indexRebuildTimer = setTimeout(() => this.persistIndex(), 5000);
  }

  // ── View Management ────────────────────────────────────────────────────────

  async activateView(): Promise<void> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(LLAMA_CHAT_VIEW_TYPE);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) await leaf.setViewState({ type: LLAMA_CHAT_VIEW_TYPE, active: true });
    }

    if (leaf) workspace.revealLeaf(leaf);
  }
}
