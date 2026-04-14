import { App, PluginSettingTab, Setting } from 'obsidian';
import type LlamaPlugin from './main';
import type { LlamaPluginSettings } from './types';

export const DEFAULT_SETTINGS: LlamaPluginSettings = {
  endpoint: 'http://localhost:8080',
  model: '',
  systemPromptExtra: '',
  contextWindowTokens: 32768,
  autoInjectNotes: 3,
  editPermission: 'read_append',
  toolCallingMode: 'native',
  excludePatterns: ['Private/**', '*.secret.md'],
  maxToolCallDepth: 10,
  showDiffPreview: true,
  diffPreviewThreshold: 200,
  temperature: 0.7,
  ollamaEmbedEndpoint: 'http://localhost:11434',
  embeddingModel: '',
};

export class LlamaSettingTab extends PluginSettingTab {
  plugin: LlamaPlugin;

  constructor(app: App, plugin: LlamaPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass('llama-settings');

    containerEl.createEl('h2', { text: '🦙 LLAMA Chat Settings' });

    // ── Connection ─────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🔌 Connection' });

    new Setting(containerEl)
      .setName('LLM Endpoint')
      .setDesc('Base URL of your llama.cpp server (no trailing slash)')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:8080')
          .setValue(this.plugin.settings.endpoint)
          .onChange(async value => {
            this.plugin.settings.endpoint = value.replace(/\/$/, '');
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Model Name')
      .setDesc('Model identifier to request (leave blank to use server default)')
      .addText(text =>
        text
          .setPlaceholder('auto-detect')
          .setValue(this.plugin.settings.model)
          .onChange(async value => {
            this.plugin.settings.model = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Temperature')
      .setDesc('Sampling temperature (0 = deterministic, 1 = creative, 2 = chaotic)')
      .addSlider(slider =>
        slider
          .setLimits(0, 2, 0.05)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.temperature = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Context ────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🧠 Context' });

    new Setting(containerEl)
      .setName('Context Window (tokens)')
      .setDesc("Max tokens to use for context. Match your model's context size.")
      .addSlider(slider =>
        slider
          .setLimits(1024, 131072, 1024)
          .setValue(this.plugin.settings.contextWindowTokens)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.contextWindowTokens = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Auto-inject notes count')
      .setDesc('Number of top-ranked relevant notes auto-injected into each message (actual count may be lower if context budget is reached)')
      .addText(text =>
        text
          .setPlaceholder('3')
          .setValue(String(this.plugin.settings.autoInjectNotes))
          .onChange(async value => {
            const parsed = Number.parseInt(value.trim(), 10);
            if (Number.isNaN(parsed)) return;
            this.plugin.settings.autoInjectNotes = Math.max(0, parsed);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Extra system prompt')
      .setDesc('Additional instructions appended to the base system prompt')
      .addTextArea(text =>
        text
          .setPlaceholder('You prefer short, concise answers...')
          .setValue(this.plugin.settings.systemPromptExtra)
          .onChange(async value => {
            this.plugin.settings.systemPromptExtra = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Permissions ────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🔒 Vault Permissions' });

    new Setting(containerEl)
      .setName('Edit permission level')
      .setDesc('Controls what the LLM is allowed to do in your vault')
      .addDropdown(drop =>
        drop
          .addOption('read_only', '🔍 Read only — search & read notes')
          .addOption('read_append', '✏️ Read + Append — add content to notes')
          .addOption('full_edit', '⚠️ Full edit — create, modify, overwrite')
          .setValue(this.plugin.settings.editPermission)
          .onChange(async value => {
            this.plugin.settings.editPermission = value as LlamaPluginSettings['editPermission'];
            await this.plugin.saveSettings();
          })
      );

    // ── Tool Calling ───────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🛠️ Tool Calling' });

    new Setting(containerEl)
      .setName('Tool calling mode')
      .setDesc(
        'Native: OpenAI-style function calling (requires compatible model). Prompt injection: works with any model. Disabled: no vault tools.'
      )
      .addDropdown(drop =>
        drop
          .addOption('native', '⚡ Native function calling')
          .addOption('prompt_injection', '📝 Prompt injection (universal)')
          .addOption('disabled', '🚫 Disabled')
          .setValue(this.plugin.settings.toolCallingMode)
          .onChange(async value => {
            this.plugin.settings.toolCallingMode = value as LlamaPluginSettings['toolCallingMode'];
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName('Max tool call depth')
      .setDesc('Maximum number of consecutive tool calls per turn (prevents infinite loops)')
      .addSlider(slider =>
        slider
          .setLimits(1, 20, 1)
          .setValue(this.plugin.settings.maxToolCallDepth)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.maxToolCallDepth = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Privacy ────────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🙈 Privacy' });

    new Setting(containerEl)
      .setName('Exclude patterns')
      .setDesc('Glob patterns for notes/folders to hide from the LLM (comma-separated)')
      .addTextArea(text =>
        text
          .setPlaceholder('Private/**, Diary/**, *.secret.md')
          .setValue(this.plugin.settings.excludePatterns.join(', '))
          .onChange(async value => {
            this.plugin.settings.excludePatterns = value
              .split(',')
              .map(p => p.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    // ── Semantic Embeddings ──────────────────────────────────────────
    containerEl.createEl('h3', { text: '🧠 Semantic Embeddings (optional)' });

    containerEl.createEl('p', {
      text: 'When enabled, notes are embedded using Ollama and a vector similarity search replaces the keyword-only ranking. ' +
            'This means only the most relevant notes are injected into context — scaling gracefully to 200+ note vaults. ' +
            'Requires Ollama running locally with a text-embedding model (e.g. \'nomic-embed-text\').'
    }).style.cssText = 'font-size: 12px; color: var(--text-muted); margin: 0 0 8px;';

    new Setting(containerEl)
      .setName('Ollama Embeddings URL')
      .setDesc('Base URL of your Ollama instance (default: http://localhost:11434)')
      .addText(text =>
        text
          .setPlaceholder('http://localhost:11434')
          .setValue(this.plugin.settings.ollamaEmbedEndpoint)
          .onChange(async value => {
            this.plugin.settings.ollamaEmbedEndpoint = value.replace(/\/$/, '') || 'http://localhost:11434';
            await this.plugin.saveSettings();
            this.plugin.embeddingIndex.updateSettings(this.plugin.settings);
          })
      );

    new Setting(containerEl)
      .setName('Embedding model')
      .setDesc('Ollama model name for embeddings (leave blank to disable). Example: nomic-embed-text, mxbai-embed-large')
      .addText(text =>
        text
          .setPlaceholder('nomic-embed-text')
          .setValue(this.plugin.settings.embeddingModel)
          .onChange(async value => {
            this.plugin.settings.embeddingModel = value.trim();
            await this.plugin.saveSettings();
            this.plugin.embeddingIndex.updateSettings(this.plugin.settings);
          })
      );

    // ── Edit Safety ────────────────────────────────────────────────────────
    containerEl.createEl('h3', { text: '🛡️ Edit Safety' });

    new Setting(containerEl)
      .setName('Show diff preview')
      .setDesc('Show a change preview in chat before applying edits')
      .addToggle(toggle =>
        toggle.setValue(this.plugin.settings.showDiffPreview).onChange(async value => {
          this.plugin.settings.showDiffPreview = value;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName('Diff preview threshold (chars)')
      .setDesc('Only show diff preview when the edit changes more than this many characters')
      .addSlider(slider =>
        slider
          .setLimits(0, 2000, 50)
          .setValue(this.plugin.settings.diffPreviewThreshold)
          .setDynamicTooltip()
          .onChange(async value => {
            this.plugin.settings.diffPreviewThreshold = value;
            await this.plugin.saveSettings();
          })
      );
  }
}
