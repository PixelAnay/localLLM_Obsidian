/**
 * ChatView.ts — Engram sidebar view
 * Slim orchestrator wiring all sub-components.
 */

import { ItemView, WorkspaceLeaf, Notice, setIcon } from 'obsidian';
import type EngramPlugin from './main';
import type { ChatMessage, StreamChunk, MessageContentPart } from './types';
import { SessionManager } from './chat/SessionManager';
import { AttachmentHandler, type Attachment } from './chat/AttachmentHandler';
import { MentionAutocomplete } from './chat/MentionAutocomplete';
import { MessageRenderer, type DisplayMessage, type ToolEvent } from './ui/MessageRenderer';
import { TokenBudgetBar } from './ui/TokenBudgetBar';
import { SlashCommandHandler } from './commands/SlashCommandHandler';
import { estimateMessagesTokens } from './utils/tokenEstimator';
import { showConfirmDialog } from './ui/ConfirmDialog';

export const ENGRAM_VIEW_TYPE = 'engram-view';
/** @deprecated Use ENGRAM_VIEW_TYPE */
export const LLAMA_CHAT_VIEW_TYPE = ENGRAM_VIEW_TYPE;

export class ChatView extends ItemView {
  private plugin: EngramPlugin;

  // ── State ─────────────────────────────────────────────────────────────────
  private messages: ChatMessage[] = [];
  private displayMessages: DisplayMessage[] = [];
  private isStreaming = false;
  private pendingAttachments: Attachment[] = [];
  /** Token estimate of the last-built system prompt (persona + memory + vault map).
   *  Used to show accurate context usage in the token budget bar. */
  private lastSystemTokens = 0;

  // ── Sub-components ────────────────────────────────────────────────────────
  private sessionManager!: SessionManager;
  private attachmentHandler!: AttachmentHandler;
  private mentionAutocomplete!: MentionAutocomplete;
  private slashCommandHandler!: SlashCommandHandler;
  private messageRenderer!: MessageRenderer;
  private tokenBudgetBar!: TokenBudgetBar;

  // ── DOM refs ──────────────────────────────────────────────────────────────
  private statusDot!: HTMLElement;
  private statusLabel!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private inputArea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private noteCountEl!: HTMLElement;
  private chatSelectBtn!: HTMLButtonElement;
  private attachInput!: HTMLInputElement;
  private attachmentPreviewEl!: HTMLElement;
  private permBadge!: HTMLElement;
  private providerBadge!: HTMLElement;
  private personaBadge!: HTMLElement;
  private contextStatusEl!: HTMLElement;
  private memoryToast!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: EngramPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return ENGRAM_VIEW_TYPE; }
  getDisplayText(): string { return 'Engram'; }
  getIcon(): string { return 'brain'; }

  async onOpen(): Promise<void> {
    this.isStreaming = false;
    this.buildUI();

    this.sessionManager = new SessionManager(this.plugin);
    this.attachmentHandler = new AttachmentHandler();
    this.messageRenderer = new MessageRenderer(
      this.app,
      this.messagesContainer,
      this,
      (content) => navigator.clipboard.writeText(content),
      (idx) => this.editMessage(idx),
      (idx) => this.regenerateMessage(idx),
      (path) => this.openNotes([path]),
      this.plugin.indexer
    );

    this.plugin.toolExecutor.onOpenNotes = (paths: string[]) => this.openNotes(paths);

    // Slash commands
    this.slashCommandHandler = new SlashCommandHandler(
      this.inputArea,
      this.inputArea.parentElement!,
      {
        onMemory: () => this.runMemoryExtraction(),
        onForget: () => this.plugin.openMemoryFile(),
        onPersona: () => this.showPersonaSwitcher(),
        onExport: () => this.exportConversation(),
        onClear: () => this.clearChat(),
        onScope: () => this.showScopeInfo(),
      }
    );

    // Mention autocomplete
    this.mentionAutocomplete = new MentionAutocomplete(
      this.inputArea,
      this.inputArea.parentElement!,
      this.plugin.indexer,
      () => { /* note selected */ }
    );

    const session = this.sessionManager.initialize();
    this.messages = [...session.messages];
    this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);

    this.renderMessages();
    this.refreshSessionControls();
    this.updateProviderBadge();
    this.updatePersonaBadge();
    await this.checkConnection();
  }

  async onClose(): Promise<void> {
    this.plugin.providerFactory.abort();
    this.isStreaming = false;
    this.tokenBudgetBar?.destroy();
    this.mentionAutocomplete?.destroy();
    this.slashCommandHandler?.hide();

    // Clean up overlays
    const doc = activeDocument;
    doc.querySelectorAll(
      '.engram-chat-overlay, .engram-persona-overlay, .engram-undo-panel-overlay, .engram-modal-overlay'
    ).forEach(el => el.remove());
  }

  // ── UI Construction ────────────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('engram-chat-root');
    root.setCssStyles({ padding: '0' });

    // ── Header ────────────────────────────────────────────────────────────────
    const header = root.createDiv('engram-header');

    const titleRow = header.createDiv('engram-header-title-row');
    titleRow.createSpan('engram-header-icon').textContent = '🧠';
    titleRow.createSpan('engram-header-title').textContent = 'Engram';

    // Provider + persona badges
    const badgeRow = header.createDiv('engram-header-badge-row');
    this.providerBadge = badgeRow.createSpan('engram-provider-badge');
    this.personaBadge = badgeRow.createEl('button', { cls: 'engram-persona-switcher' });
    this.personaBadge.title = 'Switch persona';
    this.personaBadge.addEventListener('click', () => this.showPersonaSwitcher());

    // Status row
    const statusRow = header.createDiv('engram-header-status-row');
    this.statusDot = statusRow.createSpan('engram-status-dot');
    this.statusLabel = statusRow.createSpan('engram-status-label');
    this.statusLabel.textContent = 'Connecting…';
    this.noteCountEl = statusRow.createSpan('engram-note-count');

    // Session controls
    const sessionControls = header.createDiv('engram-chat-session-controls');
    this.chatSelectBtn = sessionControls.createEl('button', { cls: 'engram-chat-select-btn', title: 'Switch chat' });
    this.chatSelectBtn.addEventListener('click', () => {
      if (this.isStreaming) return;
      this.showChatSwitcher();
    });

    const newChatBtn = sessionControls.createEl('button', {
      cls: 'engram-session-btn', text: 'New chat', title: 'Start new chat',
    });
    newChatBtn.addEventListener('click', () => this.startNewChat());

    // Header action buttons
    const headerActions = header.createDiv('engram-header-actions');

    const refreshBtn = headerActions.createEl('button', { cls: 'engram-icon-btn', title: 'Check connection' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.checkConnection());

    const memoryBtn = headerActions.createEl('button', { cls: 'engram-icon-btn', title: 'Open memory file' });
    setIcon(memoryBtn, 'book-open');
    memoryBtn.addEventListener('click', () => this.plugin.openMemoryFile());

    const undoBtn = headerActions.createEl('button', { cls: 'engram-icon-btn', title: 'Undo last AI edit' });
    setIcon(undoBtn, 'rotate-ccw');
    undoBtn.addEventListener('click', () => this.showUndoPanel());

    const settingsBtn = headerActions.createEl('button', { cls: 'engram-icon-btn', title: 'Settings' });
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      (this.app as any).setting?.open();
      (this.app as any).setting?.openTabById('engram-chat');
    });

    // Context status + memory toast
    this.contextStatusEl = header.createDiv('engram-context-status');
    this.contextStatusEl.setCssStyles({ display: 'none' });

    this.memoryToast = header.createDiv('engram-memory-toast');
    this.memoryToast.setCssStyles({ display: 'none' });

    // ── Messages ──────────────────────────────────────────────────────────────
    this.messagesContainer = root.createDiv('engram-messages');

    // ── Input bar ─────────────────────────────────────────────────────────────
    const inputBar = root.createDiv('engram-input-bar');
    this.attachmentPreviewEl = inputBar.createDiv('engram-input-attachments');

    const inputWrapper = inputBar.createDiv('engram-input-wrapper');

    this.inputArea = inputWrapper.createEl('textarea', {
      cls: 'engram-input',
      attr: { placeholder: 'Ask anything… or type / for commands', rows: '1' },
    });

    this.inputArea.addEventListener('input', () => {
      this.inputArea.setCssStyles({ height: 'auto' });
      this.inputArea.setCssStyles({ height: Math.min(this.inputArea.scrollHeight, 160) + 'px' });
      const consumed = this.slashCommandHandler?.handleInput();
      if (!consumed) this.mentionAutocomplete?.handleInput();
    });

    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (this.slashCommandHandler?.handleKeydown(e)) return;
      if (this.mentionAutocomplete?.handleKeydown(e)) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming) this.sendMessage();
      }
    });

    this.inputArea.addEventListener('blur', () => {
      setTimeout(() => {
        this.mentionAutocomplete?.hide();
        this.slashCommandHandler?.hide();
      }, 200);
    });

    this.inputArea.addEventListener('keyup', (e) => {
      if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Backspace'].includes(e.key)) {
        this.mentionAutocomplete?.handleCursorMove();
      }
    });

    this.inputArea.addEventListener('click', () => {
      this.mentionAutocomplete?.handleCursorMove();
    });

    const btnGroup = inputBar.createDiv('engram-btn-group');

    const attachBtn = btnGroup.createEl('button', { cls: 'engram-attach-btn', title: 'Attach files' });
    setIcon(attachBtn, 'paperclip');

    this.attachInput = btnGroup.createEl('input', {
      attr: { type: 'file', multiple: 'true', style: 'display:none' },
    });
    attachBtn.addEventListener('click', () => this.attachInput.click());
    this.attachInput.addEventListener('change', async (e: Event) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files) return;
      const newAtts = await this.attachmentHandler.processFiles(files);
      this.pendingAttachments.push(...newAtts);
      this.renderAttachmentPreviews();
      (e.target as HTMLInputElement).value = '';
    });

    btnGroup.createDiv('engram-btn-spacer');

    this.sendBtn = btnGroup.createEl('button', { cls: 'engram-send-btn', text: 'Send' });
    setIcon(this.sendBtn, 'send');
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.stopBtn = btnGroup.createEl('button', { cls: 'engram-stop-btn', text: 'Stop' });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.setCssStyles({ display: 'none' });
    this.stopBtn.addEventListener('click', () => {
      this.plugin.providerFactory.abort();
      this.setStreaming(false);
    });

    // ── Footer ─────────────────────────────────────────────────────────────────
    const footer = root.createDiv('engram-footer');

    this.permBadge = footer.createSpan('engram-perm-badge');
    this.updatePermBadge();
    this.permBadge.addEventListener('click', async () => {
      const current = this.plugin.settings.editPermission;
      let next: 'read_only' | 'read_append' | 'full_edit';
      if (current === 'read_only') {
        next = 'read_append';
      } else if (current === 'read_append') {
        next = 'full_edit';
      } else {
        next = 'read_only';
      }
      this.plugin.settings.editPermission = next;
      await this.plugin.saveSettings();

      const names: Record<string, string> = {
        read_only: 'Read Only',
        read_append: 'Append',
        full_edit: 'Full Edit',
      };
      new Notice(`Permission set to: ${names[next]}`);
      this.updatePermBadge();
    });

    this.tokenBudgetBar = new TokenBudgetBar(footer, this.plugin.settings.contextWindowTokens);

    // Drag & Drop support
    let dragCounter = 0;
    root.addEventListener('dragenter', (e: DragEvent) => {
      e.preventDefault();
      dragCounter++;
      if (dragCounter === 1) {
        root.addClass('drag-over');
      }
    });

    root.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
    });

    root.addEventListener('dragleave', (e: DragEvent) => {
      e.preventDefault();
      dragCounter = Math.max(0, dragCounter - 1);
      if (dragCounter === 0) {
        root.removeClass('drag-over');
      }
    });

    root.addEventListener('drop', async (e: DragEvent) => {
      e.preventDefault();
      dragCounter = 0;
      root.removeClass('drag-over');
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        const newAtts = await this.attachmentHandler.processFiles(files);
        if (newAtts.length > 0) {
          this.pendingAttachments.push(...newAtts);
          this.renderAttachmentPreviews();
        }
      }
    });
  }

  // ── Connection ─────────────────────────────────────────────────────────────

  async checkConnection(): Promise<void> {
    this.setStatus('connecting');
    try {
      const model = await this.plugin.providerFactory.healthCheck();
      this.setStatus('connected', model);
    } catch (e) {
      this.setStatus('error', (e as Error).message);
    }
    if (this.plugin.indexer.isReady) {
      this.noteCountEl.textContent = `${this.plugin.indexer.noteCount} notes`;
    }
  }

  private setStatus(state: 'connecting' | 'connected' | 'error', info?: string): void {
    this.statusDot.className = `engram-status-dot engram-status-${state}`;
    if (state === 'connected') {
      this.statusLabel.textContent = info ? `Connected · ${info}` : 'Connected';
    } else if (state === 'error') {
      this.statusLabel.textContent = `Offline · ${info ?? ''}`;
    } else {
      this.statusLabel.textContent = 'Connecting…';
    }
  }

  private updatePermBadge(): void {
    const icons: Record<string, string> = {
      read_only: '🔍 Read',
      read_append: '✏️ Append',
      full_edit: '⚠️ Full edit',
    };
    this.permBadge.textContent = icons[this.plugin.settings.editPermission] ?? '?';
  }

  private updateProviderBadge(): void {
    const preset = this.plugin.settings;
    const isLocal = ['local_llamacpp', 'local_ollama', 'local_lmstudio'].includes(preset.activeProviderId);
    this.providerBadge.empty();
    const dot = this.providerBadge.createSpan('engram-provider-dot');
    dot.addClass(isLocal ? 'engram-provider-dot--local' : 'engram-provider-dot--cloud');
    this.providerBadge.appendText(
      preset.model
        ? `${preset.model}`
        : isLocal ? 'Local AI' : 'Cloud AI'
    );
  }

  private updatePersonaBadge(): void {
    const persona = this.plugin.settings.personas.find(
      p => p.id === this.plugin.settings.activePersonaId
    );
    this.personaBadge.empty();
    this.personaBadge.createSpan().textContent = '🎭 ';
    this.personaBadge.createSpan('engram-persona-name').textContent = persona?.name ?? 'Default';
  }

  async onSettingsUpdate(): Promise<void> {
    this.updateProviderBadge();
    this.updatePersonaBadge();
    this.updatePermBadge();
    this.tokenBudgetBar?.setMax(this.plugin.settings.contextWindowTokens);
    this.updateTokenBar();
    await this.checkConnection();
  }

  /**
   * Called by EngramPlugin when chat sessions change due to an external vault sync
   * (i.e., a new/modified/deleted .json file appeared in the chat history folder).
   * Refreshes the session list. If the currently active session was deleted on
   * another device, switches to the most recent remaining session.
   */
  onExternalSessionsChanged(): void {
    if (this.isStreaming) return;
    const activeId = this.sessionManager.currentId;
    const activeStillExists = this.plugin.chatSessions.some(s => s.id === activeId);

    if (!activeStillExists && this.plugin.chatSessions.length > 0) {
      // Active session was removed externally — switch to the first available
      const next = this.plugin.chatSessions[0];
      this.switchToSession(next.id);
    } else {
      this.refreshSessionControls();
    }
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  private switchToSession(id: string): void {
    if (this.isStreaming) return;
    const session = this.sessionManager.switchTo(id);
    if (!session) return;
    this.messages = [...session.messages];
    this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();
    this.renderMessages();
    this.refreshSessionControls();
    this.updateTokenBar();
  }

  private startNewChat(): void {
    if (this.isStreaming) return;
    this.sessionManager.createAndActivate();
    this.messages = [];
    this.displayMessages = [];
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();
    this.renderMessages();
    this.refreshSessionControls();
    this.updateTokenBar();
    this.inputArea.focus();
  }


  private clearChat(): void {
    if (this.isStreaming) return;
    this.messages = [];
    this.displayMessages = [];
    this.sessionManager.clearCurrentMessages();
    this.renderMessages();
    this.updateTokenBar();
  }

  private refreshSessionControls(): void {
    if (!this.chatSelectBtn) return;
    this.chatSelectBtn.empty();
    
    const session = this.sessionManager.currentSession;
    const title = session?.title ?? 'Select chat…';
    
    const textSpan = this.chatSelectBtn.createSpan({ text: title, cls: 'engram-chat-select-btn-text' });
    const iconSpan = this.chatSelectBtn.createSpan({ cls: 'engram-chat-select-btn-icon' });
    setIcon(iconSpan, 'chevron-down');

    const has = this.sessionManager.allSessions.length > 0;
    this.chatSelectBtn.disabled = !has || this.isStreaming;
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    const hasAtts = this.pendingAttachments.length > 0;
    if ((!text && !hasAtts) || this.isStreaming) return;

    this.setStreaming(true);

    this.inputArea.value = '';
    this.inputArea.setCssStyles({ height: 'auto' });

    const attachmentsForSend = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();

    let apiContent: string | MessageContentPart[] = text;
    let historyContent: string | MessageContentPart[] = text;

    if (attachmentsForSend.length > 0) {
      apiContent = AttachmentHandler.buildContentParts(text, attachmentsForSend, false) as MessageContentPart[];
      historyContent = AttachmentHandler.buildContentParts(text, attachmentsForSend, true) as MessageContentPart[];
    }

    const userDisplayMsg: DisplayMessage = { role: 'user', content: text, attachments: attachmentsForSend };
    this.displayMessages.push(userDisplayMsg);
    this.messages.push({ role: 'user', content: historyContent, attachments: [] });
    this.sessionManager.updateTitleFromPrompt(text);
    this.sessionManager.save(this.messages);

    this.messageRenderer.appendBubble(userDisplayMsg);
    this.scrollToBottom();

    await this.executeTurn(text, apiContent, userDisplayMsg);
  }

  private async executeTurn(
    textForContext: string,
    apiContent: string | MessageContentPart[],
    userDisplayMsg: DisplayMessage
  ): Promise<void> {
    try {
      this.showContextStatus('Building context…');
      let attachedNotesList: string[] = [];
      const enriched = await this.plugin.contextBuilder.prependSystemMessage(
        this.messages.slice(0, -1),
        textForContext || 'See attachment(s)',
        (s) => this.showContextStatus(s),
        (paths) => { attachedNotesList = paths; }
      );

      // Capture system prompt token cost for accurate token bar display.
      // Must be done before the user message is pushed onto enriched.
      this.lastSystemTokens = estimateMessagesTokens(enriched.filter(m => m.role === 'system'));

      if (attachedNotesList.length > 0) {
        const userMsg = this.messages[this.messages.length - 1];
        if (userMsg) {
          userMsg.autoAttachedNotes = attachedNotesList;
        }
        userDisplayMsg.autoAttachedNotes = attachedNotesList;
        this.messageRenderer.finalizeStreamingBubble(userDisplayMsg);
      }

      enriched.push({ role: 'user', content: apiContent });
      this.hideContextStatus();

      const assistantDisplay: DisplayMessage = { role: 'assistant', content: '', streaming: true, toolEvents: [] };
      this.displayMessages.push(assistantDisplay);
      this.messageRenderer.appendBubble(assistantDisplay);

      let finalMessages: ChatMessage[] = enriched;

      const onChunk = (chunk: StreamChunk) => {
        if (chunk.type === 'token' && chunk.content) {
          assistantDisplay.content += chunk.content;
          this.messageRenderer.patchStreamingContent(assistantDisplay);
        } else if (chunk.type === 'tool_start') {
          assistantDisplay.toolEvents!.push({ type: 'start', name: chunk.toolName! });
          this.messageRenderer.patchStreamingContent(assistantDisplay);
        } else if (chunk.type === 'tool_end') {
          const evList = assistantDisplay.toolEvents!;
          let last: ToolEvent | undefined;
          for (let i = evList.length - 1; i >= 0; i--) {
            if (evList[i].name === chunk.toolName && evList[i].type === 'start') { last = evList[i]; break; }
          }
          if (!last && evList.length > 0) last = evList[evList.length - 1];
          if (last) { last.type = 'end'; last.result = chunk.toolResult; }
          this.messageRenderer.patchStreamingContent(assistantDisplay);
        } else if (chunk.type === 'error' && chunk.error) {
          assistantDisplay.content = chunk.error;
          (assistantDisplay as any).role = 'error';
          assistantDisplay.streaming = false;
          this.messageRenderer.finalizeStreamingBubble(assistantDisplay);
        } else if (chunk.type === 'done') {
          assistantDisplay.streaming = false;
          this.messageRenderer.finalizeStreamingBubble(assistantDisplay);
        }
        this.scrollToBottom();
      };

      try {
        const gen = this.plugin.providerFactory.runTurn(enriched, this.plugin.toolExecutor, onChunk);
        for await (const msgs of gen) {
          finalMessages = msgs;
        }
      } catch (e) {
        assistantDisplay.content = `Error: ${(e as Error).message}`;
        (assistantDisplay as any).role = 'error';
        assistantDisplay.streaming = false;
        this.messageRenderer.finalizeStreamingBubble(assistantDisplay);
      }

      // ── Critical: preserve full message history ──────────────────────────
      const newTurnMessages = finalMessages
        .slice(enriched.length)
        .filter(m => m.role !== 'system');
      this.messages = [...this.messages, ...newTurnMessages];
      this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);
      this.sessionManager.save(this.messages);
      this.updateTokenBar();
    } catch (e) {
      new Notice(`Error: ${(e as Error).message}`);
    } finally {
      this.setStreaming(false);
      this.scrollToBottom();
    }

    // Auto memory extraction (silent, non-blocking)
    if (this.plugin.settings.memoryEnabled && this.plugin.settings.autoExtractMemory) {
      this.plugin.memoryExtractor.extractAndSave(
        this.messages.slice(-6),
        (count) => {
          if (count > 0) this.showMemoryToast(count);
        }
      );
    }
  }

  // ── Memory ─────────────────────────────────────────────────────────────────

  private async runMemoryExtraction(): Promise<void> {
    if (this.messages.length < 2) {
      new Notice('Not enough conversation to extract from');
      return;
    }
    new Notice('🧠 Extracting memories…');
    const count = await this.plugin.memoryExtractor.extractAndSave(
      this.messages.slice(-10),
      (n) => { if (n > 0) this.showMemoryToast(n); }
    );
    if (count === 0) new Notice('Nothing new worth remembering in this conversation');
  }

  private showMemoryToast(count: number): void {
    this.memoryToast.textContent = `🧠 Saved ${count} fact${count > 1 ? 's' : ''} to memory`;
    this.memoryToast.setCssStyles({ display: 'block' });
    setTimeout(() => { this.memoryToast.setCssStyles({ display: 'none' }); }, 3000);
  }


  // ── Chat switcher ──────────────────────────────────────────────────────────

  private showChatSwitcher(): void {
    const document = activeDocument;
    document.querySelectorAll('.engram-chat-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'engram-modal-overlay engram-chat-overlay';

    const panel = overlay.appendChild(document.createElement('div'));
    panel.className = 'engram-modal';

    const title = panel.appendChild(document.createElement('div'));
    title.className = 'engram-modal-title';
    title.textContent = '💬 Switch Chat';

    const sub = panel.appendChild(document.createElement('div'));
    sub.className = 'engram-modal-subtitle';
    sub.textContent = 'Select, rename, or delete conversation history.';

    const list = panel.appendChild(document.createElement('div'));
    list.className = 'engram-chat-list';

    for (const session of this.sessionManager.allSessions) {
      const item = list.appendChild(document.createElement('div'));
      item.className = 'engram-chat-item';
      if (session.id === this.sessionManager.currentId) {
        item.addClass('is-active');
        item.setCssStyles({ borderColor: 'var(--color-accent)' });
      }

      const name = item.appendChild(document.createElement('span'));
      name.className = 'engram-chat-desc';
      name.textContent = session.title;
      
      name.addEventListener('click', (e) => {
        e.stopPropagation();
        this.switchToSession(session.id);
        overlay.remove();
      });

      const actions = item.appendChild(document.createElement('div'));
      actions.className = 'engram-chat-item-actions';

      const renameBtn = actions.appendChild(document.createElement('button'));
      renameBtn.className = 'engram-chat-item-btn';
      renameBtn.title = 'Rename chat';
      setIcon(renameBtn, 'pencil');
      
      renameBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        
        // Inline rename
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'engram-chat-rename-input';
        input.value = session.title;
        
        item.replaceChild(input, name);
        actions.setCssStyles({ display: 'none' });
        
        input.focus();
        input.select();
        
        let saved = false;
        const saveRename = async () => {
          if (saved) return;
          saved = true;
          const newTitle = input.value.trim();
          if (newTitle && newTitle !== session.title) {
            session.title = newTitle;
            session.updatedAt = Date.now();
            this.plugin.upsertChatSession(session);
            this.refreshSessionControls();
          }
          this.showChatSwitcher();
        };

        input.addEventListener('keydown', (ke) => {
          if (ke.key === 'Enter') {
            input.removeEventListener('blur', saveRename);
            saveRename();
          } else if (ke.key === 'Escape') {
            saved = true;
            input.removeEventListener('blur', saveRename);
            this.showChatSwitcher();
          }
        });

        input.addEventListener('blur', saveRename);
      });

      const deleteBtn = actions.appendChild(document.createElement('button'));
      deleteBtn.className = 'engram-chat-item-btn is-danger';
      deleteBtn.title = 'Delete chat';
      setIcon(deleteBtn, 'trash-2');
      deleteBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const confirmed = await showConfirmDialog(this.app, {
          title: 'Delete Chat',
          message: `Are you sure you want to delete chat "${session.title}"?`,
          confirmLabel: 'Delete',
          cancelLabel: 'Cancel',
          danger: true,
        });
        if (confirmed) {
          const next = this.sessionManager.delete(session.id);
          this.messages = [...next.messages];
          this.displayMessages = MessageRenderer.buildDisplayMessages(this.messages);
          this.pendingAttachments = [];
          this.renderMessages();
          this.refreshSessionControls();
          this.updateTokenBar();
          
          this.showChatSwitcher();
        }
      });
    }

    const closeBtn = panel.appendChild(document.createElement('button'));
    closeBtn.className = 'engram-modal-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.setCssStyles({ marginTop: '8px' });
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
  }

  // ── Persona switcher ───────────────────────────────────────────────────────

  private showPersonaSwitcher(): void {
    const document = activeDocument;
    document.querySelectorAll('.engram-persona-overlay').forEach(el => el.remove());

    const overlay = document.createElement('div');
    overlay.className = 'engram-modal-overlay engram-persona-overlay';

    const panel = overlay.appendChild(document.createElement('div'));
    panel.className = 'engram-modal';

    const title = panel.appendChild(document.createElement('div'));
    title.className = 'engram-modal-title';
    title.textContent = '🎭 Switch Persona';

    const sub = panel.appendChild(document.createElement('div'));
    sub.className = 'engram-modal-subtitle';
    sub.textContent = 'Takes effect from the next message.';

    const list = panel.appendChild(document.createElement('div'));
    list.className = 'engram-undo-list';

    for (const persona of this.plugin.settings.personas) {
      const item = list.appendChild(document.createElement('div'));
      item.className = 'engram-undo-item';
      if (persona.id === this.plugin.settings.activePersonaId) item.setCssStyles({ borderColor: 'var(--color-accent)' });

      const name = item.appendChild(document.createElement('span'));
      name.className = 'engram-undo-desc';
      name.textContent = persona.name;

      if (persona.id === this.plugin.settings.activePersonaId) {
        const active = item.appendChild(document.createElement('span'));
        active.className = 'engram-undo-time';
        active.textContent = 'active';
      }

      item.addEventListener('click', async () => {
        this.plugin.settings.activePersonaId = persona.id;
        await this.plugin.saveSettings();
        this.updatePersonaBadge();
        overlay.remove();
        new Notice(`🎭 Persona: ${persona.name}`);
      });
    }

    const closeBtn = panel.appendChild(document.createElement('button'));
    closeBtn.className = 'engram-modal-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.setCssStyles({ marginTop: '8px' });
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
  }

  // ── Export ─────────────────────────────────────────────────────────────────

  private async exportConversation(): Promise<void> {
    if (this.messages.length === 0) { new Notice('Nothing to export'); return; }
    const session = this.sessionManager.currentSession;
    const title = session?.title ?? 'Conversation';
    const date = new Date().toISOString().slice(0, 10);
    // Sanitize title to remove path-unsafe characters (M-03)
    const sanitizedTitle = title.replace(/[*"\\/<>:|?]/g, '-').trim();
    const path = `Exports/${sanitizedTitle} ${date}.md`;

    let content = `# ${title}\n*Exported ${date}*\n\n`;
    for (const msg of this.messages.filter(m => m.role !== 'system')) {
      const role = msg.role === 'user' ? '**You**' : '**Engram**';
      const text = typeof msg.content === 'string' ? msg.content : '[attachment]';
      content += `${role}: ${text}\n\n`;
    }

    try {
      await this.app.vault.createFolder('Exports').catch(() => {});
      await this.app.vault.create(path, content);
      new Notice(`📝 Exported to ${path}`);
    } catch (e) {
      new Notice(`Export failed: ${(e as Error).message}`);
    }
  }

  // ── Scope info ─────────────────────────────────────────────────────────────

  private showScopeInfo(): void {
    const { scopeMode, scopeFolders } = this.plugin.settings;
    const msg = scopeMode === 'all'
      ? '📁 Scope: All vault folders'
      : scopeMode === 'allowlist'
        ? `📁 Allow-only: ${scopeFolders.join(', ') || 'none'}`
        : `📁 Blocked: ${scopeFolders.join(', ') || 'none'}`;
    new Notice(msg);
  }

  // ── Undo panel ────────────────────────────────────────────────────────────

  private showUndoPanel(): void {
    const document = activeDocument;
    const history = this.plugin.toolExecutor.undoHistory;
    if (history.length === 0) { new Notice('Nothing to undo'); return; }

    document.querySelectorAll('.engram-undo-panel-overlay').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.className = 'engram-modal-overlay engram-undo-panel-overlay';

    const panel = overlay.appendChild(document.createElement('div'));
    panel.className = 'engram-modal engram-undo-panel';

    const title = panel.appendChild(document.createElement('div'));
    title.className = 'engram-modal-title';
    title.textContent = '↩️ Undo History';

    const sub = panel.appendChild(document.createElement('div'));
    sub.className = 'engram-modal-subtitle';
    sub.textContent = 'Click an entry to undo that operation.';

    const list = panel.appendChild(document.createElement('div'));
    list.className = 'engram-undo-list';

    [...history].reverse().forEach((entry, ri) => {
      const actualIdx = history.length - 1 - ri;
      const item = list.appendChild(document.createElement('div'));
      item.className = 'engram-undo-item';

      const desc = item.appendChild(document.createElement('span'));
      desc.className = 'engram-undo-desc';
      desc.textContent = entry.description;

      const time = item.appendChild(document.createElement('span'));
      time.className = 'engram-undo-time';
      const ago = Math.round((Date.now() - entry.timestamp) / 1000);
      time.textContent = ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`;

      item.addEventListener('click', async () => {
        overlay.remove();
        const path = await this.plugin.toolExecutor.undoAt(actualIdx);
        new Notice(path ? `↩️ Undid: "${entry.description}"` : 'Could not undo');
      });
    });

    const closeBtn = panel.appendChild(document.createElement('button'));
    closeBtn.className = 'engram-modal-cancel';
    closeBtn.textContent = 'Close';
    closeBtn.setCssStyles({ marginTop: '8px' });
    closeBtn.addEventListener('click', () => overlay.remove());
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });

    document.body.appendChild(overlay);
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private renderMessages(): void {
    if (this.displayMessages.length === 0) {
      this.messageRenderer.renderAll(this.displayMessages); // Clear memory/debounces (M-04)
      this.renderWelcome();
      return;
    }
    this.messageRenderer.renderAll(this.displayMessages);
    this.scrollToBottom();
  }

  private renderWelcome(): void {
    const welcome = this.messagesContainer.createDiv('engram-welcome');
    welcome.createEl('div', { cls: 'engram-welcome-emoji', text: '🧠' });
    welcome.createEl('div', { cls: 'engram-welcome-title', text: 'Engram' });
    welcome.createEl('div', { cls: 'engram-welcome-subtitle', text: 'The AI that remembers you' });

    const chips = welcome.createDiv('engram-welcome-chips');
    const dynamicChips: string[] = [];

    if (this.plugin.indexer.isReady) {
      const topTags = this.plugin.indexer.getTopTags(3);
      for (const tag of topTags) dynamicChips.push(`🔍 Search notes tagged ${tag}`);
      const recent = this.plugin.indexer.getRecentNotes(2);
      for (const note of recent) dynamicChips.push(`📖 Summarise ${note.title}`);
    }

    const examples = dynamicChips.length >= 3 ? dynamicChips : [
      '💭 What are my main goals right now?',
      '📔 Help me reflect on last week',
      '🧩 What patterns do you see in my notes?',
      '✏️ Help me write something',
    ];

    for (const ex of examples) {
      const chip = chips.createEl('button', { cls: 'engram-example-chip', text: ex });
      chip.addEventListener('click', () => {
        this.inputArea.value = ex.replace(/^[^\s]+\s/, '').trim();
        this.inputArea.focus();
      });
    }
  }

  private editMessage(idx: number): void {
    if (this.isStreaming) return;
    if (idx < 0 || idx >= this.displayMessages.length) return;
    const msg = this.displayMessages[idx];
    let userCount = 0;
    for (let i = 0; i < idx; i++) {
      if (this.displayMessages[i].role === 'user') userCount++;
    }
    let mIdx = -1, mUserCount = 0;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') {
        if (mUserCount === userCount) { mIdx = i; break; }
        mUserCount++;
      }
    }
    if (mIdx !== -1) this.messages = this.messages.slice(0, mIdx);
    this.displayMessages = this.displayMessages.slice(0, idx);
    this.inputArea.value = msg.content;
    this.inputArea.focus();
    this.inputArea.setCssStyles({ height: 'auto' });
    this.inputArea.setCssStyles({ height: this.inputArea.scrollHeight + 'px' });
    if (msg.attachments) { this.pendingAttachments = [...msg.attachments]; this.renderAttachmentPreviews(); }
    this.renderMessages();
    this.sessionManager.save(this.messages);
  }

  private async regenerateMessage(idx: number): Promise<void> {
    if (this.isStreaming) return;
    if (idx < 0 || idx >= this.displayMessages.length) return;

    let userCount = 0;
    for (let i = 0; i < idx; i++) {
      if (this.displayMessages[i].role === 'user') userCount++;
    }
    let mIdx = -1, mUserCount = 0;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') {
        if (mUserCount === userCount - 1) { mIdx = i; break; }
        mUserCount++;
      }
    }
    if (mIdx === -1) return;

    const userMsg = this.messages[mIdx];
    const userDisplayMsg = this.displayMessages[idx - 1];

    this.messages = this.messages.slice(0, mIdx + 1);
    this.displayMessages = this.displayMessages.slice(0, idx);

    this.sessionManager.save(this.messages);
    this.renderMessages();

    this.setStreaming(true);

    let text = '';
    let apiContent: string | MessageContentPart[] = '';
    if (typeof userMsg.content === 'string') {
      text = userMsg.content;
      apiContent = userMsg.content;
    } else if (Array.isArray(userMsg.content)) {
      text = userMsg.content
        .filter(p => p && p.type === 'text' && typeof p.text === 'string')
        .map(p => p.text as string)
        .join('\n');
      apiContent = userMsg.content;
    }

    await this.executeTurn(text, apiContent, userDisplayMsg);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async openNotes(paths: string[]): Promise<void> {
    for (let i = 0; i < paths.length; i++) {
      const file = this.app.vault.getAbstractFileByPath(paths[i]);
      if (file) await this.app.workspace.getLeaf('tab').openFile(file as any, { active: i === 0 });
    }
  }

  private showContextStatus(status: string): void {
    this.contextStatusEl.textContent = status;
    this.contextStatusEl.setCssStyles({ display: 'block' });
  }

  private hideContextStatus(): void {
    this.contextStatusEl.setCssStyles({ display: 'none' });
    this.contextStatusEl.textContent = '';
  }

  private updateTokenBar(): void {
    // Show the token count that will actually be sent to the API on the NEXT turn:
    //   • system prompt (persona + memory + vault map) — captured after last build
    //   • recent chat messages (capped at maxRecentMessages, same as the API payload)
    // This gives an accurate picture of real context-window usage, not just history size.
    const maxRecent = this.plugin.settings.maxRecentMessages ?? 20;
    const recentMessages = this.messages.slice(-maxRecent);
    const chatTokens = estimateMessagesTokens(recentMessages);
    const used = chatTokens + this.lastSystemTokens;
    this.tokenBudgetBar?.setMax(this.plugin.settings.contextWindowTokens);
    this.tokenBudgetBar?.update(used);
  }

  private setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
    this.sendBtn.setCssStyles({ display: streaming ? 'none' : 'flex' });
    this.stopBtn.setCssStyles({ display: streaming ? 'flex' : 'none' });
    this.inputArea.disabled = streaming;
    this.refreshSessionControls();
    if (!streaming) {
      this.inputArea.focus();
      this.updatePermBadge();
      this.updateProviderBadge();
      this.updatePersonaBadge();
    }
  }

  private renderAttachmentPreviews(): void {
    this.attachmentPreviewEl.empty();
    this.pendingAttachments.forEach((att, i) => {
      const chip = this.attachmentPreviewEl.createDiv('engram-attachment-chip');
      chip.createSpan('engram-attachment-name').textContent = att.name;
      const removeBtn = chip.createSpan('engram-attachment-remove');
      setIcon(removeBtn, 'x');
      removeBtn.addEventListener('click', () => {
        this.pendingAttachments.splice(i, 1);
        this.renderAttachmentPreviews();
      });
    });
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }
}
