import { ItemView, WorkspaceLeaf, MarkdownRenderer, Notice, setIcon, Component } from 'obsidian';
import type LlamaPlugin from './main';
import type { ChatMessage, StreamChunk, MessageContentPart } from './types';

/** Render Markdown safely across Obsidian versions */
function renderMarkdownCompat(
  app: Parameters<typeof MarkdownRenderer.render>[0],
  source: string,
  el: HTMLElement,
  component: Component
): void {
  try {
    // Obsidian 1.0+ static method
    MarkdownRenderer.render(app, source, el, '', component);
  } catch {
    // Fallback: older Obsidian API
    (MarkdownRenderer as any).renderMarkdown(source, el, '', component);
  }
}

const CHAT_HISTORY_KEY = 'llama-chat-history';

async function getPdfJs(): Promise<any> {
  if ((window as any).pdfjsLib) return (window as any).pdfjsLib;
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js';
    script.onload = () => {
      (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
      resolve((window as any).pdfjsLib);
    };
    script.onerror = () => reject(new Error('Failed to load pdf.js from CDN'));
    document.head.appendChild(script);
  });
}

function renderPdfPageToDataUrl(pdfDoc: any, pageNum: number): Promise<string> {
  return new Promise(async (resolve, reject) => {
    try {
      const page = await pdfDoc.getPage(pageNum);
      // scale 2.0 ensures text is crisp enough for the vision model
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('No canvas context'));
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderContext = { canvasContext: ctx, viewport: viewport };
      await page.render(renderContext).promise;

      resolve(canvas.toDataURL('image/jpeg', 0.85));
    } catch (e) {
      reject(e);
    }
  });
}

export const LLAMA_CHAT_VIEW_TYPE = 'llama-chat-view';

interface DisplayMessage {
  role: 'user' | 'assistant' | 'error';
  content: string;
  attachments?: { name: string; type: string; dataUrl: string }[];
  toolEvents?: ToolEvent[];
  streaming?: boolean;
}

interface ToolEvent {
  type: 'start' | 'end';
  name: string;
  result?: string;
}

export class ChatView extends ItemView {
  private plugin: LlamaPlugin;
  private messages: ChatMessage[] = [];
  private displayMessages: DisplayMessage[] = [];
  private isStreaming = false;
  private pendingAttachments: { name: string; type: string; dataUrl: string }[] = [];

  // DOM refs
  private statusDot!: HTMLElement;
  private statusLabel!: HTMLElement;
  private messagesContainer!: HTMLElement;
  private inputArea!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private stopBtn!: HTMLButtonElement;
  private noteCountEl!: HTMLElement;
  private attachInput!: HTMLInputElement;
  private attachmentPreviewEl!: HTMLElement;

  constructor(leaf: WorkspaceLeaf, plugin: LlamaPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string { return LLAMA_CHAT_VIEW_TYPE; }
  getDisplayText(): string { return 'LLAMA Chat'; }
  getIcon(): string { return 'message-circle'; }

  async onOpen(): Promise<void> {
    this.buildUI();
    await this.checkConnection();
  }

  async onClose(): Promise<void> {
    this.plugin.llmClient.abort();
  }

  // ── UI Construction ────────────────────────────────────────────────────────

  private buildUI(): void {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass('llama-chat-root');
    root.style.padding = '0';  // override Obsidian's default .view-content padding

    // ── Header ──────────────────────────────────────────────────────────────
    const header = root.createDiv('llama-header');

    const titleRow = header.createDiv('llama-header-title-row');
    const icon = titleRow.createSpan('llama-header-icon');
    icon.textContent = '🦙';
    titleRow.createSpan('llama-header-title').textContent = 'LLAMA Chat';

    const statusRow = header.createDiv('llama-header-status-row');
    this.statusDot = statusRow.createSpan('llama-status-dot');
    this.statusLabel = statusRow.createSpan('llama-status-label');
    this.statusLabel.textContent = 'Connecting…';

    this.noteCountEl = statusRow.createSpan('llama-note-count');

    const headerActions = header.createDiv('llama-header-actions');

    const refreshBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Check connection' });
    setIcon(refreshBtn, 'refresh-cw');
    refreshBtn.addEventListener('click', () => this.checkConnection());

    const clearBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Clear chat' });
    setIcon(clearBtn, 'trash-2');
    clearBtn.addEventListener('click', () => this.clearChat());

    const undoBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Undo last AI edit' });
    setIcon(undoBtn, 'rotate-ccw');
    undoBtn.addEventListener('click', () => this.undoLastEdit());

    const settingsBtn = headerActions.createEl('button', { cls: 'llama-icon-btn', title: 'Plugin settings' });
    setIcon(settingsBtn, 'settings');
    settingsBtn.addEventListener('click', () => {
      (this.app as any).setting.open();
      (this.app as any).setting.openTabById('obsidian-llama-chat');
    });

    // ── Messages ─────────────────────────────────────────────────────────────
    this.messagesContainer = root.createDiv('llama-messages');
    this.renderWelcome();

    // ── Input Bar ─────────────────────────────────────────────────────────────
    const inputBar = root.createDiv('llama-input-bar');

    this.attachmentPreviewEl = inputBar.createDiv('llama-input-attachments');

    this.inputArea = inputBar.createEl('textarea', {
      cls: 'llama-input',
      attr: { placeholder: 'Ask anything about your vault…', rows: '1' },
    });

    this.inputArea.addEventListener('input', () => {
      // Auto-grow textarea
      this.inputArea.style.height = 'auto';
      this.inputArea.style.height = Math.min(this.inputArea.scrollHeight, 160) + 'px';
    });

    this.inputArea.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming) this.sendMessage();
      }
    });

    const btnGroup = inputBar.createDiv('llama-btn-group');

    const attachBtn = btnGroup.createEl('button', { cls: 'llama-attach-btn', title: 'Attach files' });
    setIcon(attachBtn, 'paperclip');

    this.attachInput = btnGroup.createEl('input', { attr: { type: 'file', multiple: 'true', style: 'display: none' } });
    attachBtn.addEventListener('click', () => this.attachInput.click());

    this.attachInput.addEventListener('change', async (e: Event) => {
      const target = e.target as HTMLInputElement;
      const files = target.files;
      if (!files) return;
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        if (f.type === 'application/pdf') {
          try {
            new Notice(`Processing PDF: ${f.name}...`);
            const pdfjsLib = await getPdfJs();
            const arrayBuffer = await f.arrayBuffer();
            const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;

            const pagesToConvert = Math.min(pdfDoc.numPages, 14);
            for (let p = 1; p <= pagesToConvert; p++) {
              const dataUrl = await renderPdfPageToDataUrl(pdfDoc, p);
              this.pendingAttachments.push({
                name: `${f.name} (Page ${p})`,
                type: 'image/jpeg',
                dataUrl
              });
            }
            if (pdfDoc.numPages > 14) {
              new Notice(`Limited ${f.name} to first 14 pages to avoid context overload.`);
            } else {
              new Notice(`Finished processing ${f.name}`);
            }
          } catch (err) {
            console.error('PDF parsing error', err);
            new Notice('Failed to parse PDF pages into images.');
          }
        } else {
          const dataUrl = await new Promise<string>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result as string);
            reader.readAsDataURL(f);
          });
          this.pendingAttachments.push({ name: f.name, type: f.type, dataUrl });
        }
      }
      this.renderAttachmentPreviews();
      target.value = '';
    });

    btnGroup.createDiv('llama-btn-spacer');

    this.sendBtn = btnGroup.createEl('button', { cls: 'llama-send-btn', text: 'Send' });
    setIcon(this.sendBtn, 'send');
    this.sendBtn.addEventListener('click', () => this.sendMessage());

    this.stopBtn = btnGroup.createEl('button', { cls: 'llama-stop-btn', text: 'Stop' });
    setIcon(this.stopBtn, 'square');
    this.stopBtn.style.display = 'none';
    this.stopBtn.addEventListener('click', () => {
      this.plugin.llmClient.abort();
      this.setStreaming(false);
    });

    // ── Permission badge ──────────────────────────────────────────────────────
    const footer = root.createDiv('llama-footer');

    const permBadge = footer.createSpan('llama-perm-badge');
    const permIcons: Record<string, string> = {
      read_only: '🔍 Read only',
      read_append: '✏️ Read + Append',
      full_edit: '⚠️ Full edit',
    };
    permBadge.textContent = permIcons[this.plugin.settings.editPermission] ?? '?';
    permBadge.title = 'Vault edit permission level — change in settings';

    const modelBadge = footer.createSpan('llama-model-badge');
    modelBadge.textContent = this.plugin.settings.model || 'auto model';
  }

  // ── Connection Check ───────────────────────────────────────────────────────

  async checkConnection(): Promise<void> {
    this.setStatus('connecting');
    try {
      const model = await this.plugin.llmClient.healthCheck();
      this.setStatus('connected', model);
    } catch (e) {
      this.setStatus('error', (e as Error).message);
    }

    // Update note count
    if (this.plugin.indexer.isReady) {
      this.noteCountEl.textContent = `${this.plugin.indexer.noteCount} notes indexed`;
    } else {
      this.noteCountEl.textContent = 'Indexing…';
    }
  }

  private setStatus(state: 'connecting' | 'connected' | 'error', info?: string): void {
    this.statusDot.className = `llama-status-dot llama-status-${state}`;
    if (state === 'connected') {
      this.statusLabel.textContent = info ? `Connected · ${info}` : 'Connected';
    } else if (state === 'error') {
      this.statusLabel.textContent = `Offline · ${info ?? ''}`;
    } else {
      this.statusLabel.textContent = 'Connecting…';
    }
  }

  // ── Sending Messages ───────────────────────────────────────────────────────

  private async sendMessage(): Promise<void> {
    const text = this.inputArea.value.trim();
    const hasAttachments = this.pendingAttachments.length > 0;
    if ((!text && !hasAttachments) || this.isStreaming) return;

    this.inputArea.value = '';
    this.inputArea.style.height = 'auto';

    const attachmentsToMove = [...this.pendingAttachments];
    this.pendingAttachments = [];
    this.renderAttachmentPreviews();

    let content: string | MessageContentPart[] = text;
    if (attachmentsToMove.length > 0) {
      const parts: MessageContentPart[] = [];
      if (text) {
        parts.push({ type: 'text', text });
      }
      for (const att of attachmentsToMove) {
        // OpenAI schema strictly enforces 'type' to be either 'text' or 'image_url'.
        // For other formats (PDFs, Audio), passing the base64 string with the correct MIME type
        // through the 'image_url' parameter allows the backend to handle it seamlessly.
        parts.push({ type: 'image_url', image_url: { url: att.dataUrl } });
      }
      content = parts;
    }

    // Add user message to display
    this.displayMessages.push({ role: 'user', content: text, attachments: attachmentsToMove });
    this.messages.push({ role: 'user', content, attachments: attachmentsToMove });
    this.renderMessages();

    this.setStreaming(true);

    // Build context-enriched messages
    const enrichedMessages = await this.plugin.contextBuilder.prependSystemMessage(
      this.messages.slice(0, -1), // all except the just-added user msg (context builder handles it)
      text || "See attachment(s)"
    );
    enrichedMessages.push({ role: 'user', content });

    // Add empty streaming bubble
    const assistantDisplay: DisplayMessage = { role: 'assistant', content: '', streaming: true, toolEvents: [] };
    this.displayMessages.push(assistantDisplay);
    this.renderMessages();

    let finalMessages: ChatMessage[] = enrichedMessages;

    const onChunk = (chunk: StreamChunk) => {
      if (chunk.type === 'token' && chunk.content) {
        assistantDisplay.content += chunk.content;
        this.updateLastBubble(assistantDisplay);
      } else if (chunk.type === 'tool_start') {
        assistantDisplay.toolEvents!.push({ type: 'start', name: chunk.toolName! });
        this.updateLastBubble(assistantDisplay);
      } else if (chunk.type === 'tool_end') {
        const evList = assistantDisplay.toolEvents!;
        let last: ToolEvent | undefined;
        for (let i = evList.length - 1; i >= 0; i--) {
          if (evList[i].name === chunk.toolName && evList[i].type === 'start') { last = evList[i]; break; }
        }
        if (!last && evList.length > 0) last = evList[evList.length - 1];
        if (last) { last.type = 'end'; last.result = chunk.toolResult; }
        this.updateLastBubble(assistantDisplay);
      } else if (chunk.type === 'error' && chunk.error) {
        assistantDisplay.content = chunk.error;
        assistantDisplay.role = 'error' as any;
        this.updateLastBubble(assistantDisplay);
      } else if (chunk.type === 'done') {
        assistantDisplay.streaming = false;
        this.updateLastBubble(assistantDisplay);
      }
    };

    try {
      const gen = this.plugin.llmClient.runTurn(enrichedMessages, this.plugin.toolExecutor, onChunk);
      for await (const msgs of gen) {
        finalMessages = msgs;
      }
    } catch (e) {
      assistantDisplay.content = `Error: ${(e as Error).message}`;
      assistantDisplay.role = 'error' as any;
      assistantDisplay.streaming = false;
      this.updateLastBubble(assistantDisplay);
    }

    // Update canonical message history with final state (excluding system)
    this.messages = finalMessages.filter(m => m.role !== 'system');

    this.setStreaming(false);
    this.scrollToBottom();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────

  private editMessage(msg: DisplayMessage): void {
    const idx = this.displayMessages.indexOf(msg);
    if (idx === -1) return;

    // Count how many user messages came before this one in display
    let userCount = 0;
    for (let i = 0; i < idx; i++) {
      if (this.displayMessages[i].role === 'user') userCount++;
    }

    // Find the corresponding user message in the canonical state (this.messages)
    let mIdx = -1;
    let mUserCount = 0;
    for (let i = 0; i < this.messages.length; i++) {
      if (this.messages[i].role === 'user') {
        if (mUserCount === userCount) { mIdx = i; break; }
        mUserCount++;
      }
    }

    // Truncate state to conceptually "rewind" time
    if (mIdx !== -1) {
      this.messages = this.messages.slice(0, mIdx);
    }
    this.displayMessages = this.displayMessages.slice(0, idx);

    // Put content back into the input box
    this.inputArea.value = msg.content;
    this.inputArea.focus();
    this.inputArea.style.height = 'auto';
    this.inputArea.style.height = this.inputArea.scrollHeight + 'px';

    if (msg.attachments) {
      this.pendingAttachments = [...msg.attachments];
      this.renderAttachmentPreviews();
    }

    this.renderMessages();
  }

  private renderWelcome(): void {
    const welcome = this.messagesContainer.createDiv('llama-welcome');
    welcome.createEl('div', { cls: 'llama-welcome-emoji', text: '🦙' });
    welcome.createEl('div', { cls: 'llama-welcome-title', text: 'LLAMA Chat' });
    welcome.createEl('div', {
      cls: 'llama-welcome-subtitle',
      text: 'Your local AI assistant with full vault access',
    });

    const chips = welcome.createDiv('llama-welcome-chips');
    const examples = [
      '🔍 Search my notes on machine learning',
      '📝 Summarize my recent todos',
      '✏️ Add a section to my README',
      '📁 List what\'s in my Projects folder',
    ];
    for (const ex of examples) {
      const chip = chips.createEl('button', { cls: 'llama-example-chip', text: ex });
      chip.addEventListener('click', () => {
        this.inputArea.value = ex.slice(2).trim();
        this.inputArea.focus();
      });
    }
  }

  private renderMessages(): void {
    this.messagesContainer.empty();

    if (this.displayMessages.length === 0) {
      this.renderWelcome();
      return;
    }

    for (const msg of this.displayMessages) {
      this.renderBubble(msg, this.messagesContainer);
    }

    this.scrollToBottom();
  }

  private renderBubble(msg: DisplayMessage, container: HTMLElement): HTMLElement {
    const wrapper = container.createDiv(`llama-msg-wrapper llama-msg-${msg.role}`);

    // Avatar
    const avatar = wrapper.createDiv('llama-avatar');
    avatar.textContent = msg.role === 'user' ? '👤' : msg.role === 'error' ? '⚠️' : '🦙';

    const bubble = wrapper.createDiv('llama-bubble');

    // Tool events (shown above the response text)
    if (msg.toolEvents && msg.toolEvents.length > 0) {
      const toolsEl = bubble.createDiv('llama-tool-events');
      for (const ev of msg.toolEvents) {
        const evEl = toolsEl.createDiv(`llama-tool-event llama-tool-${ev.type}`);
        const icons: Record<string, string> = {
          search_vault: '🔍', read_note: '📖', list_folder: '📁',
          append_to_note: '✏️', edit_note: '✏️', create_note: '📄',
        };
        const icon = icons[ev.name] ?? '🛠️';
        if (ev.type === 'start') {
          evEl.textContent = `${icon} ${ev.name.replace(/_/g, ' ')}…`;
        } else {
          const summary = ev.result
            ? ev.result.length > 80 ? ev.result.slice(0, 80) + '…' : ev.result
            : 'done';
          evEl.textContent = `${icon} ${ev.name.replace(/_/g, ' ')}: ${summary}`;
        }
      }
    }

    // Message content (Markdown rendered)
    const contentEl = bubble.createDiv('llama-bubble-content');

    if (msg.attachments && msg.attachments.length > 0) {
      const attContainer = bubble.createDiv('llama-input-attachments');
      attContainer.style.marginBottom = msg.content ? '8px' : '0';
      for (const att of msg.attachments) {
        if (att.type.startsWith('image/')) {
          const img = attContainer.createEl('img', { attr: { src: att.dataUrl, alt: att.name } });
          img.style.maxWidth = '100%';
          img.style.borderRadius = 'var(--radius-s)';
          img.style.maxHeight = '200px';
          img.style.objectFit = 'contain';
        } else {
          const chip = attContainer.createDiv('llama-attachment-chip');
          chip.createSpan('llama-attachment-name').textContent = att.name;
        }
      }
    }

    if (msg.content) {
      renderMarkdownCompat(this.app, msg.content, contentEl, this);
    }

    // Streaming cursor
    if (msg.streaming) {
      const cursor = bubble.createSpan('llama-cursor');
      cursor.textContent = '▋';
    }

    // Actions bar (Copy / Edit)
    if (!msg.streaming && msg.role !== 'error') {
      const actions = wrapper.createDiv('llama-msg-actions');

      const copyBtn = actions.createEl('button', { cls: 'llama-msg-action-btn', title: 'Copy' });
      setIcon(copyBtn, 'copy');
      copyBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(msg.content);
        setIcon(copyBtn, 'check');
        setTimeout(() => setIcon(copyBtn, 'copy'), 2000);
      });

      if (msg.role === 'user') {
        const editBtn = actions.createEl('button', { cls: 'llama-msg-action-btn', title: 'Edit & Resend' });
        setIcon(editBtn, 'pencil');
        editBtn.addEventListener('click', () => this.editMessage(msg));
      }
    }

    return wrapper;
  }

  private updateLastBubble(msg: DisplayMessage): void {
    // Re-render just the last bubble in place
    const wrappers = this.messagesContainer.querySelectorAll('.llama-msg-wrapper');
    const last = wrappers[wrappers.length - 1];
    if (last) {
      const newEl = document.createElement('div');
      this.renderBubble(msg, newEl as any);
      last.replaceWith(newEl.firstChild!);
    }
    this.scrollToBottom();
  }

  private scrollToBottom(): void {
    requestAnimationFrame(() => {
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
    });
  }

  // ── Actions ────────────────────────────────────────────────────────────────

  private clearChat(): void {
    this.messages = [];
    this.displayMessages = [];
    this.renderMessages();
  }

  private async undoLastEdit(): Promise<void> {
    const path = await this.plugin.toolExecutor.undoLast();
    if (path) {
      new Notice(`↩️ Undid last AI edit to "${path}"`);
    } else {
      new Notice('Nothing to undo');
    }
  }

  private setStreaming(streaming: boolean): void {
    this.isStreaming = streaming;
    this.sendBtn.style.display = streaming ? 'none' : 'flex';
    this.stopBtn.style.display = streaming ? 'flex' : 'none';
    this.inputArea.disabled = streaming;
    if (!streaming) {
      // Re-focus so the user can type the next message immediately
      this.inputArea.focus();
    }
  }

  private renderAttachmentPreviews(): void {
    this.attachmentPreviewEl.empty();
    for (let i = 0; i < this.pendingAttachments.length; i++) {
      const att = this.pendingAttachments[i];
      const chip = this.attachmentPreviewEl.createDiv('llama-attachment-chip');
      chip.createSpan('llama-attachment-name').textContent = att.name;
      const removeBtn = chip.createSpan('llama-attachment-remove');
      setIcon(removeBtn, 'x');
      removeBtn.addEventListener('click', () => {
        this.pendingAttachments.splice(i, 1);
        this.renderAttachmentPreviews();
      });
    }
  }
}
