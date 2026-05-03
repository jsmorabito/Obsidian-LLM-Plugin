import LLMPlugin from "main";
import {
	App,
	ButtonComponent,
	DropdownComponent,
	Modal,
	Setting,
	setIcon,
} from "obsidian";
import { changeDefaultModel, fetchOllamaModels, getGpt4AllPath } from "utils/utils";
import { buildOllamaModels, modelNames, models } from "utils/models";
import { GPT4All, ollama } from "utils/constants";
import { FAB } from "Plugin/FAB/FAB";
import { ChatModal2 } from "Plugin/Modal/ChatModal2";

type APIKeyType = "claude" | "gemini" | "openai" | "mistral";

interface APIKeyConfig {
	name: string;
	desc: string;
	key: keyof LLMPlugin["settings"];
	generateUrl: string;
}

interface NavSection {
	id: string;
	label: string;
	items: NavItem[];
}

interface NavItem {
	id: string;
	label: string;
	icon: string;
}

export class LLMSettingsModal extends Modal {
	plugin: LLMPlugin;
	fab: FAB;
	private activeTab = "general";
	private mainContentEl: HTMLElement;

	private readonly apiKeyConfigs: Record<APIKeyType, APIKeyConfig> = {
		claude: {
			name: "Claude API key",
			desc: "Claude models require an API key for authentication.",
			key: "claudeAPIKey",
			generateUrl: "https://console.anthropic.com/settings/keys",
		},
		gemini: {
			name: "Gemini API key",
			desc: "Gemini models require an API key for authentication.",
			key: "geminiAPIKey",
			generateUrl: "https://aistudio.google.com/app/apikey",
		},
		openai: {
			name: "OpenAI API key",
			desc: "OpenAI models require an API key for authentication.",
			key: "openAIAPIKey",
			generateUrl: "https://platform.openai.com/api-keys",
		},
		mistral: {
			name: "Mistral API key",
			desc: "Mistral AI models require an API key for authentication.",
			key: "mistralAPIKey",
			generateUrl: "https://console.mistral.ai/api-keys",
		},
	};

	private readonly navSections: NavSection[] = [
		{
			id: "core",
			label: "Core Settings",
			items: [
				{ id: "general", label: "General", icon: "settings" },
				{ id: "interface", label: "Interface", icon: "layout-dashboard" },
			],
		},
		{
			id: "ai-providers",
			label: "AI Providers",
			items: [
				{ id: "api-keys", label: "API Keys", icon: "key" },
				{ id: "ollama", label: "Ollama", icon: "cpu" },
				{ id: "claude-code", label: "Claude Code", icon: "code-2" },
			],
		},
		{
			id: "chat",
			label: "Chat & History",
			items: [
				{ id: "history", label: "History", icon: "history" },
				{ id: "file-context", label: "File Context", icon: "file-text" },
			],
		},
		{
			id: "about-section",
			label: "About",
			items: [{ id: "about", label: "About", icon: "info" }],
		},
	];

	private coreModalEl: HTMLElement | null = null;
	private resizeHandler: (() => void) | null = null;
	private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

	constructor(app: App, plugin: LLMPlugin, fab: FAB) {
		super(app);
		this.plugin = plugin;
		this.fab = fab;
	}

	/** Pin our modal to the exact same rect as the core settings modal. */
	private matchCoreModal() {
		if (!this.coreModalEl) return;
		const { top, left, right, bottom } = this.coreModalEl.getBoundingClientRect();
		// Inline styles beat any CSS rule regardless of specificity.
		Object.assign(this.modalEl.style, {
			position:  "fixed",
			top:       `${top}px`,
			left:      `${left}px`,
			right:     `${window.innerWidth - right}px`,
			bottom:    `${window.innerHeight - bottom}px`,
			width:     "auto",
			height:    "auto",
			maxWidth:  "none",
			maxHeight: "none",
			minWidth:  "0",
			minHeight: "0",
			transform: "none",
			margin:    "0",
			boxShadow: "none",   // inline beats .modal-container.mod-dim .modal specificity
		});
	}

	onOpen() {
		const { modalEl } = this;
		modalEl.addClass("llm-dedicated-settings-modal");

		// Resolve the core settings modal element once.
		const appSetting = (this.app as any).setting;
		this.coreModalEl =
			appSetting?.containerEl?.closest?.(".modal") ??
			document.querySelector<HTMLElement>(".modal-container.mod-settings .modal") ??
			Array.from(document.querySelectorAll<HTMLElement>(".modal-container .modal"))
				.find((el) => el !== modalEl && !el.contains(modalEl)) ??
			null;

		// Hide our scrim so we look like part of the core settings panel.
		const modalBg = modalEl.closest(".modal-container")
			?.querySelector<HTMLElement>(".modal-bg");
		if (modalBg) modalBg.style.display = "none";

		// Apply sizing now and on every window resize.
		this.matchCoreModal();
		this.resizeHandler = () => this.matchCoreModal();
		window.addEventListener("resize", this.resizeHandler);

		// Close when the user clicks outside the modal. We defer registration by
		// one tick so the click that opened the modal doesn't immediately close it.
		this.outsideClickHandler = (e: MouseEvent) => {
			if (!this.modalEl.contains(e.target as Node)) {
				this.close();
			}
		};
		setTimeout(() => {
			document.addEventListener("mousedown", this.outsideClickHandler!);
		}, 0);

		// mod-sidebar-layout tells Obsidian's CSS to apply the two-column layout.
		modalEl.addClass("mod-sidebar-layout");

		this.contentEl.empty();
		// vertical-tabs-container is the flex wrapper Obsidian uses in its own settings.
		this.contentEl.addClass("vertical-tabs-container");

		// Sidebar — uses Obsidian's own vertical tab header classes.
		const sidebar = this.contentEl.createDiv("vertical-tab-header");
		this.buildSidebar(sidebar);

		// Content area — Obsidian's classes handle layout, scrolling, and padding.
		const contentContainer = this.contentEl.createDiv("vertical-tab-content-container");
		this.mainContentEl = contentContainer.createDiv("vertical-tab-content");
		this.renderTab(this.activeTab);
	}

	onClose() {
		if (this.resizeHandler) {
			window.removeEventListener("resize", this.resizeHandler);
			this.resizeHandler = null;
		}
		if (this.outsideClickHandler) {
			document.removeEventListener("mousedown", this.outsideClickHandler);
			this.outsideClickHandler = null;
		}
		this.contentEl.empty();
	}

	private buildSidebar(sidebar: HTMLElement) {
		for (const section of this.navSections) {
			const groupEl = sidebar.createDiv("vertical-tab-header-group");
			groupEl.createDiv({
				cls:  "vertical-tab-header-group-title",
				text: section.label,
			});

			// vertical-tab-header-group-items is the core container for items.
			const itemsEl = groupEl.createDiv("vertical-tab-header-group-items");

			for (const item of section.items) {
				const isActive = item.id === this.activeTab;
				// vertical-tab-nav-item + tappable are the core nav item classes.
				const itemEl = itemsEl.createDiv({
					cls: `vertical-tab-nav-item tappable${isActive ? " is-active" : ""}`,
				});

				// vertical-tab-nav-item-icon is the core icon container class.
				const iconEl = itemEl.createDiv("vertical-tab-nav-item-icon");
				setIcon(iconEl, item.icon);

				itemEl.createSpan({ text: item.label });

				itemEl.addEventListener("click", () => {
					sidebar
						.querySelectorAll(".vertical-tab-nav-item")
						.forEach((el) => el.removeClass("is-active"));
					itemEl.addClass("is-active");
					this.activeTab = item.id;
					this.renderTab(item.id);
				});
			}
		}
	}

	private renderTab(tabId: string) {
		this.mainContentEl.empty();
		switch (tabId) {
			case "general":       this.renderGeneral();     break;
			case "interface":     this.renderInterface();   break;
			case "api-keys":      this.renderApiKeys();     break;
			case "ollama":        this.renderOllama();      break;
			case "claude-code":   this.renderClaudeCode();  break;
			case "history":       this.renderHistory();     break;
			case "file-context":  this.renderFileContext(); break;
			case "about":         this.renderAbout();       break;
		}
	}

	// ── Tab renderers ──────────────────────────────────────────────────────────

	private renderGeneral() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "General");
		const items = this.addSettingGroup(el);

		// Default model
		new Setting(items)
			.setName("Default model")
			.setDesc("Sets the default LLM used across the plugin.")
			.addDropdown((dropdown: DropdownComponent) => {
				const ollamaBuilt = buildOllamaModels(this.plugin.settings.ollamaModels);
				const allModels = { ...models, ...ollamaBuilt.models };
				const allModelNames = { ...modelNames, ...ollamaBuilt.names };

				dropdown.addOption(
					modelNames[this.plugin.settings.defaultModel] ?? "",
					"Select default model"
				);

				for (const model of Object.keys(allModels)) {
					const type = allModels[model].type;
					if (type === ollama) {
						dropdown.addOption(allModels[model].model, model);
						continue;
					}
					if (type === GPT4All) {
						const fullPath = `${getGpt4AllPath(this.plugin)}/${allModels[model].model}`;
						if (this.plugin.fileSystem.existsSync(fullPath)) {
							dropdown.addOption(allModels[model].model, model);
						}
						continue;
					}
					dropdown.addOption(allModels[model].model, model);
				}

				dropdown.onChange((change) => {
					const name = allModelNames[change];
					if (name && allModels[name]?.type === ollama) {
						models[name] = allModels[name];
						modelNames[change] = name;
					}
					changeDefaultModel(change, this.plugin);
					this.plugin.saveSettings();
				});

				dropdown.setValue(this.plugin.settings.modalSettings.model);
			});

		// Empty chat avatar
		new Setting(items)
			.setName("Empty chat avatar")
			.setDesc("Choose which avatar to display on empty/new chats.")
			.addDropdown((dropdown: DropdownComponent) => {
				dropdown.addOption("llm-gal", "LLM Gal");
				dropdown.addOption("llm-guy", "LLM Guy");
				dropdown.addOption("zen-kid", "Zen Kid");
				dropdown.addOption("ninja-cat", "Ninja Cat");
				dropdown.setValue(this.plugin.settings.emptyChatAvatar || "llm-gal");
				dropdown.onChange(async (value) => {
					this.plugin.settings.emptyChatAvatar = value;
					await this.plugin.saveSettings();
					this.plugin.refreshAllEmptyStates();
				});
			});

		// Agent permission mode
		new Setting(items)
			.setName("Agent permission mode")
			.setDesc(
				"Controls when the agent asks for your approval before performing actions in your vault."
			)
			.addDropdown((dropdown: DropdownComponent) => {
				dropdown.addOption("ask", "Ask (approve writes, auto-allow reads)");
				dropdown.addOption("auto-approve", "Auto-approve all (no prompts)");
				dropdown.addOption("ask-everything", "Ask for everything");
				dropdown.addOption("read-only", "Read-only (deny any writes)");

				const currentMode =
					this.plugin.settings.modalSettings.agentSettings?.permissionMode ?? "ask";
				dropdown.setValue(currentMode);

				dropdown.onChange(async (value) => {
					const mode = value as import("../Types/types").PermissionMode;
					this.plugin.settings.modalSettings.agentSettings = { permissionMode: mode };
					this.plugin.settings.widgetSettings.agentSettings = { permissionMode: mode };
					this.plugin.settings.fabSettings.agentSettings = { permissionMode: mode };
					await this.plugin.saveSettings();
				});
			});
	}

	private renderInterface() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "Interface");
		const items = this.addSettingGroup(el);

		new Setting(items)
			.setName("Floating Action Button (FAB)")
			.setDesc("Show the floating action button for quick access to the chat.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showFAB)
					.onChange(async (value) => {
						this.fab.removeFab();
						this.plugin.settings.showFAB = value;
						await this.plugin.saveSettings();
						if (value) this.fab.regenerateFAB();
					});
			});

		new Setting(items)
			.setName("Ask AI in status bar")
			.setDesc(
				"Shows an 'Ask AI' button in the status bar that opens the chat popover."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showStatusBarButton)
					.onChange(async (value) => {
						this.plugin.settings.showStatusBarButton = value;
						await this.plugin.saveSettings();
						if (value) {
							this.plugin.statusBarButton.generate();
							this.plugin.recentChatsButton.generate();
						} else {
							this.plugin.statusBarButton.remove();
							this.plugin.recentChatsButton.remove();
						}
					});
			});

		new Setting(items)
			.setName("Ribbon icon")
			.setDesc("Show the 'Ask a question' icon in the ribbon bar.")
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.showRibbonIcon)
					.onChange(async (value) => {
						this.plugin.settings.showRibbonIcon = value;
						await this.plugin.saveSettings();
						if (value && !this.plugin.ribbonIconEl) {
							this.plugin.ribbonIconEl = this.plugin.addRibbonIcon(
								"bot",
								"Ask a question",
								() => {
									new ChatModal2(this.plugin).open();
								}
							);
						} else if (!value && this.plugin.ribbonIconEl) {
							this.plugin.ribbonIconEl.remove();
							this.plugin.ribbonIconEl = null;
						}
					});
			});
	}

	private renderApiKeys() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "API Keys");
		const items = this.addSettingGroup(el);

		for (const [type, config] of Object.entries(this.apiKeyConfigs) as [
			APIKeyType,
			APIKeyConfig
		][]) {
			new Setting(items)
				.setName(config.name)
				.setDesc(config.desc)
				.addText((text) => {
					text.inputEl.type = "password";
					text.setValue(this.plugin.settings[config.key] as string);
					text.onChange((value) => {
						if (value.trim().length) {
							(this.plugin.settings[config.key] as string) = value;
							this.plugin.saveSettings();
						}
					});
				})
				.addButton((button: ButtonComponent) => {
					button.setButtonText("Generate");
					button.onClick(() => window.open(config.generateUrl));
				});
		}
	}

	private renderOllama() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "Ollama");
		const items = this.addSettingGroup(el);

		new Setting(items)
			.setName("Ollama host")
			.setDesc("URL of your Ollama server (default: http://localhost:11434).")
			.addText((text) => {
				text.setPlaceholder("http://localhost:11434");
				text.setValue(this.plugin.settings.ollamaHost);
				text.onChange((value) => {
					this.plugin.settings.ollamaHost = value;
					this.plugin.saveSettings();
				});
			});

		// Discovered models list — shown between the two settings in the group.
		const modelListEl = items.createEl("p", {
			cls: "setting-item-description llm-settings-ollama-models",
		});
		if (this.plugin.settings.ollamaModels.length > 0) {
			modelListEl.setText(
				`Discovered models: ${this.plugin.settings.ollamaModels.join(", ")}`
			);
		}

		new Setting(items)
			.setName("Refresh models")
			.setDesc("Fetch available models from your Ollama server.")
			.addButton((button) => {
				button.setButtonText("Refresh");
				button.onClick(async () => {
					try {
						button.setButtonText("Fetching...");
						button.setDisabled(true);
						const foundModels = await fetchOllamaModels(
							this.plugin.settings.ollamaHost
						);
						this.plugin.settings.ollamaModels = foundModels;
						const built = buildOllamaModels(foundModels);
						Object.assign(models, built.models);
						Object.assign(modelNames, built.names);
						await this.plugin.saveSettings();
						this.renderTab("ollama");
					} catch {
						modelListEl.setText(
							"Failed to connect to Ollama. Is it running?"
						);
						button.setButtonText("Refresh");
						button.setDisabled(false);
					}
				});
			});
	}

	private renderClaudeCode() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "Claude Code");

		const authItems = this.addSettingGroup(el);
		new Setting(authItems)
			.setName("Claude Code OAuth token")
			.setDesc(
				"OAuth token for authenticating with Claude Code (CLAUDE_CODE_OAUTH_TOKEN)."
			)
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.claudeCodeOAuthToken);
				text.onChange((value) => {
					this.plugin.settings.claudeCodeOAuthToken = value;
					this.plugin.saveSettings();
				});
			});

		el.createEl("h4", {
			text: "Linear Workspaces",
			cls: "llm-dedicated-settings-subheader",
		});

		const desc = el.createEl("p", { cls: "setting-item-description" });
		desc.appendText("Add Linear workspaces with their ");
		desc.createEl("a", {
			text: "API keys",
			href: "https://linear.app/settings/account/security",
		});
		desc.appendText(". Each workspace gets its own MCP server.");

		// Workspaces and the add-button share one group so they visually card together.
		const workspaceItems = this.addSettingGroup(el);
		const workspaceListEl = workspaceItems.createDiv({ cls: "linear-workspace-list" });
		this.renderWorkspaceList(workspaceListEl);

		new Setting(workspaceItems)
			.setName("Add workspace")
			.addButton((button) => {
				button.setButtonText("+ Add Linear workspace");
				button.onClick(() => {
					this.plugin.settings.linearWorkspaces.push({ name: "", apiKey: "" });
					this.plugin.saveSettings();
					this.renderWorkspaceList(workspaceListEl);
				});
			});
	}

	private renderHistory() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "History");

		// Static settings — reset + markdown toggle in one group.
		const mainItems = this.addSettingGroup(el);

		new Setting(mainItems)
			.setName("Save chats as markdown files")
			.setDesc(
				"Store each conversation as a .md file in your vault. Enables Obsidian search, tags, and backlinks on your chat history."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.chatHistoryEnabled)
					.onChange(async (value) => {
						this.plugin.settings.chatHistoryEnabled = value;
						await this.plugin.saveSettings();
						renderHistorySection();
					});
			});

		new Setting(mainItems)
			.setName("Reset chat history")
			.setDesc("Delete all previous prompts and chat contexts.")
			.addButton((button: ButtonComponent) => {
				button.setButtonText("Reset history");
				button.setWarning();
				button.onClick(() => {
					this.plugin.history.reset();
				});
			});

		// Dynamic section (folder + migration) — own group that re-renders on toggle.
		const migrationGroup = el.createDiv("setting-group");
		const migrationEl = migrationGroup.createDiv("setting-items");

		const renderHistorySection = () => {
			migrationEl.empty();
			if (!this.plugin.settings.chatHistoryEnabled) {
				migrationGroup.style.display = "none";
				return;
			}
			migrationGroup.style.display = "";

			new Setting(migrationEl)
				.setName("History folder")
				.setDesc("Vault folder where chat files will be saved.")
				.addText((text) => {
					text.setPlaceholder("LLM Chats");
					text.setValue(this.plugin.settings.chatHistoryFolder);
					text.onChange(async (value) => {
						this.plugin.settings.chatHistoryFolder = value.trim() || "LLM Chats";
						await this.plugin.saveSettings();
					});
				});

			if (
				!this.plugin.settings.chatHistoryMigrated &&
				this.plugin.settings.promptHistory.length > 0
			) {
				new Setting(migrationEl)
					.setName("Migrate existing history")
					.setDesc(
						`You have ${this.plugin.settings.promptHistory.length} saved conversation(s) in the old format. Click to convert them to markdown files.`
					)
					.addButton((button) => {
						button.setButtonText("Migrate now");
						button.setCta();
						button.onClick(async () => {
							button.setButtonText("Migrating…");
							button.setDisabled(true);
							await this.plugin.chatHistory.migrate(
								this.plugin.settings.promptHistory
							);
							this.plugin.settings.chatHistoryMigrated = true;
							await this.plugin.saveSettings();
							renderHistorySection();
						});
					});
			} else if (this.plugin.settings.chatHistoryMigrated) {
				migrationEl.createEl("p", {
					text: "✓ Legacy history has been migrated.",
					cls: "setting-item-description",
				});
			}
		};

		renderHistorySection();
	}

	private renderFileContext() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "File Context");
		const items = this.addSettingGroup(el);

		new Setting(items)
			.setName("Enable file context")
			.setDesc(
				"Allow AI to access vault files. When disabled, the AI will not have access to any files from your vault."
			)
			.addToggle((toggle) => {
				toggle
					.setValue(this.plugin.settings.enableFileContext)
					.onChange(async (value) => {
						this.plugin.settings.enableFileContext = value;
						await this.plugin.saveSettings();
					});
			});
	}

	private renderAbout() {
		const el = this.mainContentEl;
		this.addTabHeader(el, "About");
		const items = this.addSettingGroup(el);

		new Setting(items)
			.setName("Support development")
			.setDesc("Consider donating to support ongoing development.")
			.addButton((button: ButtonComponent) => {
				button.setButtonText("Buy me a coffee ☕");
				button.setCta();
				button.onClick(() => window.open("https://www.buymeacoffee.com/johnny1093"));
			});

		const creditsEl = el.createDiv({ cls: "llm-dedicated-settings-about-credits" });
		creditsEl.createEl("p", {
			text: "LLM Plugin",
			cls: "llm-dedicated-settings-about-title",
		});
		creditsEl.createEl("p", {
			text: "By Johnny✨, Ryan Mahoney, and Evan Harris",
			cls: "setting-item-description",
		});
		creditsEl.createEl("p", {
			text: `Version ${this.plugin.manifest.version}`,
			cls: "setting-item-description",
		});
	}

	// ── Helpers ────────────────────────────────────────────────────────────────

	private addTabHeader(el: HTMLElement, title: string) {
		const header = el.createDiv("llm-dedicated-settings-tab-header");
		header.createEl("h2", {
			text: title,
			cls: "llm-dedicated-settings-tab-title",
		});
	}

	/**
	 * Creates a .setting-group > .setting-items wrapper that matches the card
	 * grouping structure used throughout Obsidian's core settings panel.
	 * Pass the returned element as the container for new Setting() calls.
	 */
	private addSettingGroup(parent: HTMLElement): HTMLElement {
		const group = parent.createDiv("setting-group");
		return group.createDiv("setting-items");
	}

	private renderWorkspaceList(containerEl: HTMLElement) {
		containerEl.empty();
		const workspaces = this.plugin.settings.linearWorkspaces;

		workspaces.forEach((ws, index) => {
			const row = new Setting(containerEl)
				.addText((text) => {
					text.setPlaceholder("Workspace name");
					text.setValue(ws.name);
					text.onChange((value) => {
						this.plugin.settings.linearWorkspaces[index].name = value;
						this.plugin.saveSettings();
					});
				})
				.addText((text) => {
					text.setPlaceholder("API key");
					text.inputEl.type = "password";
					text.setValue(ws.apiKey);
					text.onChange((value) => {
						this.plugin.settings.linearWorkspaces[index].apiKey = value;
						this.plugin.saveSettings();
					});
				})
				.addButton((button) => {
					button.setIcon("trash");
					button.setTooltip("Remove workspace");
					button.onClick(() => {
						this.plugin.settings.linearWorkspaces.splice(index, 1);
						this.plugin.saveSettings();
						this.renderWorkspaceList(containerEl);
					});
				});
			row.setName(ws.name || `Workspace ${index + 1}`);
		});
	}
}
