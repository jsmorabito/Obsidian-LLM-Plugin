# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
npm run dev      # Start development with watch mode (esbuild watches for changes)
npm run build    # Production build (TypeScript type-check + esbuild bundle)
npm run version  # Bump version in manifest.json and versions.json
```

Output is bundled to `main.js` in the root directory.

## Architecture Overview

This is an Obsidian plugin that provides LLM chat interfaces with support for OpenAI, Anthropic Claude, Google Gemini, Mistral AI, local Ollama, local LM Studio, and local GPT4All.

### Entry Point and Plugin Lifecycle

`src/main.ts` contains the `LLMPlugin` class which:
1. Initializes platform abstractions (Desktop vs Mobile)
2. Loads settings from Obsidian's data store
3. Registers commands and views
4. Initializes MessageStore, History, Assistants, and FAB components

### View Architecture (Four UI Implementations)

The plugin provides four ways to access the chat interface, all using the same underlying components:

- **Modal** (`src/Plugin/Modal/ChatModal2.ts`) - Popup dialog
- **Widget** (`src/Plugin/Widget/Widget.ts`) - Sidebar tab view
- **FAB** (`src/Plugin/FAB/FAB.ts`) - Floating Action Button with expandable chat
- **StatusBarButton** (`src/Plugin/StatusBar/StatusBarButton.ts`) - "Ask AI" button in the status bar that opens a popover chat. Uses `viewType: "floating-action-button"` and shares `fabSettings` with the FAB. Its popover is built once on `generate()` (not per-open), so call `chatContainer.syncModelDropdown()` whenever the popover is shown to keep the model dropdown in sync with settings.

Each view composes these shared components from `src/Plugin/Components/`:
- `Header.ts` - Tab navigation (Chat/History/Settings/Assistants)
- `ChatContainer.ts` - Message display, input handling, API calls
- `HistoryContainer.ts` - Chat history list
- `SettingsContainer.ts` - Model/parameter configuration
- `AssistantsContainer.ts` - OpenAI assistants selection

### State Management

- **MessageStore** (`src/Plugin/Components/MessageStore.ts`) - Pub/sub pattern for in-memory message state; synchronizes all views
- **Settings** (in `main.ts`) - Persisted configuration via Obsidian's `loadData`/`saveData`
- **HistoryHandler** (`src/History/HistoryHandler.ts`) - Manages chat history (max 10 conversations)
- **AssistantHandler** (`src/Assistants/AssistantHandler.ts`) - OpenAI assistants state

### Message Flow

1. User input in `ChatContainer` triggers `handleGenerateClick()`
2. Message added to MessageStore, which notifies all subscribers
3. API call made based on selected provider (OpenAI/Claude/Gemini/Mistral/Ollama/LM Studio/GPT4All)
4. Streaming response updates UI in real-time
5. Conversation saved to History

### Platform Abstraction

`src/services/` provides abstractions for cross-platform compatibility:
- `FileSystem.ts` - Desktop/Mobile file operations
- `OperatingSystem.ts` - Desktop/Mobile OS detection

### API Integration

Provider SDKs used:
- `openai` - Chat, images (gpt-image-1), assistants
- `@anthropic-ai/sdk` - Claude models + Claude Code (agent SDK)
- `@google/generative-ai` - Gemini models
- Mistral — uses `openai` SDK with custom baseURL (`https://api.mistral.ai/v1`)
- Ollama — uses `openai` SDK with custom baseURL (default `http://localhost:11434/v1`); models discovered dynamically via `fetchOllamaModels()`
- LM Studio — uses `openai` SDK with custom baseURL (default `http://localhost:1234/v1`); models discovered dynamically via `fetchLMStudioModels()`; **must use `encoding_format: "float"` for embeddings** — the OpenAI SDK's default base64 format triggers a known GGUF bug in LM Studio that returns all-zero vectors (lmstudio-ai/lmstudio-bug-tracker#1647)
- GPT4All connects to local server on port 4891

### RAG / Vault Search

The plugin supports semantic search over the user's vault via three classes in `src/RAG/`:

- **`VectorStore.ts`** — Persists embeddings as a flat JSON file (path passed via constructor). Provides cosine similarity search and incremental updates (skips files whose `mtime` hasn't changed). `save()` ensures the parent directory exists before writing — always use `vault.adapter.mkdir()` guard before any `adapter.write()` to a plugin-relative path, as the directory may not exist on fresh installs.
- **`EmbeddingService.ts`** — Provider-agnostic embedding generation. Supports OpenAI (`text-embedding-3-small`), Gemini (`text-embedding-004`), Ollama, and LM Studio (all via the OpenAI-compatible `/v1/embeddings` endpoint). LM Studio calls must pass `encoding_format: "float"` explicitly. Reuses API keys/hosts already stored in plugin settings.
- **`VaultIndexer.ts`** — Orchestrates indexing (chunking by paragraph, ~1500 chars per chunk with file path + heading prefix) and exposes `semanticSearch(query, topK)` which returns a formatted markdown context block. Calls `EmbeddingService.checkOllamaModel()` before indexing to surface a clear pull-command error if the Ollama model isn't available.

**How it integrates:**
- `LLMPlugin.vaultIndexer` is the singleton instance; call `plugin.initVaultIndexer()` after any RAG setting change.
- `LLMPlugin` registers `vault.on('modify')`, `vault.on('delete')`, and `vault.on('rename')` events to keep the index incrementally up-to-date. Modify events are debounced (2 s) to avoid hammering the embedding API during rapid autosaves.
- `ObsidianToolRegistry` receives the `VaultIndexer` and exposes a `search_vault_semantic` tool (`risk: "safe"`). Tool-capable models (Claude, GPT-4, Gemini, Ollama, Mistral) call this autonomously via `AgentLoop`.
- `AgentLoop` fires `AgentCallbacks.onToolResult(toolName, result)` after each successful tool execution — `ChatContainer` uses this to capture `search_vault_semantic` results and populate the cited sources panel.
- `ChatContainer` has a `useVaultSearch` toggle (toolbar button, visible when RAG is enabled) that pre-fills `pendingContextString` with top-k results — useful as a fallback or for models where the user wants guaranteed vault context. After generation, a collapsible "Sources" panel (`<details class="llm-rag-sources">`) is appended listing the contributing files as clickable links.
- Search uses **hybrid scoring**: 70% cosine similarity + 30% BM25 keyword score. BM25 IDF is computed at search time across the in-memory corpus. The `VectorStore.hybridSearch()` method handles both; `VectorStore.search()` delegates to it with full vector weight for pure semantic use.
- RAG settings live under `plugin.settings.ragSettings` (`RAGSettings` type in `types.ts`) and are configured in `LLMSettingsModal` under the "Vault Search" tab.

### Key Files

- `src/Types/types.ts` - TypeScript interfaces (ChatParams, ImageParams, RAGSettings, etc.)
- `src/utils/constants.ts` - Provider/model/endpoint constants (includes `images`, `chat`, `messages`, `assistant`, `claudeCodeEndpoint`, etc.)
- `src/utils/models.ts` - Model configuration definitions
- `src/utils/utils.ts` - API validation and helper functions

### Constants Convention

All endpoint type strings live in `src/utils/constants.ts` and must be imported as constants rather than compared against raw string literals. The full set of endpoint constants is: `chat`, `messages`, `images`, `claudeCodeEndpoint`. Provider type constants are: `openAI`, `claude`, `claudeCode`, `gemini`, `mistral`, `ollama`, `lmStudio`, `GPT4All`.

### CSS / Styling Convention

- Always use Obsidian CSS variables (`--size-4-2`, `--font-ui-small`, `--text-muted`, `--interactive-accent`, etc.) instead of hardcoded px/em/color values.
- Use `--icon-xs` / `--icon-s` for icon sizes rather than raw pixel values.
- Component-specific styles belong in `styles.css` as named classes — never use inline `element.style.*` assignments in TypeScript (use `.addClass()` with a CSS class instead).
- `FileSelector.ts` uses the `.llm-file-selector-*` family of classes defined in `styles.css`.

## Build Configuration

- **esbuild** bundles to CommonJS format targeting ES2018
- External dependencies: `obsidian`, `electron`, `@codemirror/*`, Node builtins
- SVG files loaded inline via esbuild loader
- TypeScript configured with strict null checks, baseUrl `src`
