# LLAMA Chat for Obsidian

Sidebar chat for Obsidian powered by a local LLM server (llama.cpp-compatible), with vault-aware context, search, and controlled note editing tools.

## Features

- Desktop sidebar chat view inside Obsidian
- Local LLM endpoint support (`/v1/chat/completions` + `/v1/models`)
- Vault indexing of Markdown notes with automatic background refresh
- Relevance-based note auto-injection into system context
- Tool calling for vault operations:
  - Search notes
  - Read note content
  - List folder notes
  - Append to notes
  - Edit notes (replace block / full overwrite)
  - Create notes
  - Open notes in editor tabs
- Permission modes for safety:
  - `read_only`
  - `read_append`
  - `full_edit`
- Undo for last AI edit
- Exclusion patterns for private files/folders
- Optional diff preview controls
- Attachment support in chat input (including PDF pages rendered as images)

## Requirements

- Obsidian desktop (plugin is desktop-only)
- A locally running OpenAI-compatible LLM endpoint (tested workflow assumes llama.cpp server)
- Endpoint that supports:
  - `GET /v1/models`
  - `POST /v1/chat/completions` (streaming)

Default endpoint in settings: `http://localhost:8080`

## Installation

### Option 1: Manual install (release-style)

1. Build plugin files:
   - `npm install`
   - `npm run build`
2. Copy these files to your vault plugin folder:
   - `main.js`
   - `manifest.json`
   - `styles.css`
3. Destination folder should be:
   - `<YourVault>/.obsidian/plugins/obsidian-llama-chat/`
4. In Obsidian:
   - Open **Settings → Community plugins**
   - Enable **LLAMA Chat**

### Option 2: Development workflow

1. Clone this repo into your Obsidian plugin development location.
2. Install dependencies:
   - `npm install`
3. Start watch build:
   - `npm run dev`
4. Reload Obsidian after changes.

## Usage

1. Click the ribbon icon to open **LLAMA Chat** sidebar.
2. Confirm connection status in the header.
3. Ask questions normally.
4. For vault-specific questions, the plugin can search and read notes automatically.
5. Use plugin settings to control edit permissions and privacy exclusions.

### Commands

- `Open LLAMA Chat sidebar`
- `LLAMA Chat: Re-index vault`

## Settings

### Connection

- **LLM Endpoint**: base URL for your local server (no trailing slash)
- **Model Name**: optional model ID; leave blank for server default
- **Temperature**: sampling temperature (0–2)

### Context

- **Context Window (tokens)**: prompt budget target
- **Auto-inject notes count**: number of top-ranked notes auto-added
- **Extra system prompt**: custom instructions appended to system prompt

### Permissions and Tools

- **Edit permission level**:
  - `read_only` for safe read/search only
  - `read_append` for adding content to existing notes
  - `full_edit` for full create/overwrite capabilities
- **Tool calling mode**:
  - `native` (OpenAI function calling)
  - `prompt_injection` (fallback for models without native tool calling)
  - `disabled`
- **Max tool call depth**: caps chained tool execution per turn

### Privacy and Safety

- **Exclude patterns**: glob patterns (e.g. `Private/**`, `*.secret.md`)
- **Show diff preview**
- **Diff preview threshold**

## How Vault Context Works

- Indexes Markdown files and metadata (path, title, tags, frontmatter, mtime)
- Maintains a vault map used in the system prompt
- Auto-selects top relevant notes for injection based on user query
- Updates index on vault create/modify/delete/rename events

## Scripts

- `npm run dev`: esbuild watch mode
- `npm run build`: Type-check + production bundle

## Project Structure

- `src/main.ts`: plugin lifecycle, commands, view registration
- `src/ChatView.ts`: chat UI, streaming, attachments, undo action wiring
- `src/llm.ts`: LLM API client and streaming/tool-call handling
- `src/indexer.ts`: vault indexing and search helpers
- `src/context.ts`: system prompt and context assembly
- `src/tools.ts`: tool schemas + executor
- `src/settings.ts`: plugin settings UI and defaults

## Troubleshooting

- **Offline status in header**:
  - Verify local server is running
  - Verify endpoint in settings (default `http://localhost:8080`)
  - Confirm `GET /v1/models` responds
- **No vault-aware answers**:
  - Wait for initial indexing to complete
  - Check exclusion patterns are not too broad
  - Use `LLAMA Chat: Re-index vault`
- **Edits are blocked**:
  - Increase edit permission level in settings
- **Tool calls not working with your model**:
  - Switch tool mode to `prompt_injection`

## Security Notes

- This plugin can modify your vault depending on selected permission mode.
- Keep `read_only` unless you explicitly need write actions.
- Review outputs and use undo when needed.

## License

MIT
