/**
 * LoopRunner — executes loops headlessly (no ChatContainer, no user present).
 *
 * One run = worker AgentLoop → optional independent verifier AgentLoop →
 * run log + STATE.md update + Notice.
 *
 * Safety model (nobody is there to approve tool calls):
 *  - The permission callback always denies; `ask` / `auto-approve` are never used.
 *  - `read-only` loops use the existing read-only permission mode.
 *  - `staging` loops use the `staging` permission mode plus a ToolGuard that
 *    denies any write whose `path` is outside the loop's drafts/ folder, and
 *    denies danger-tier / UI tools outright. Enforced in code, not the prompt.
 *  - No dynamic tools are registered (no invoke_assistant, enable_skill,
 *    save_memory) — a loop can't change settings, memories, or personas.
 *
 * Runs are serialised through a single queue: one loop runs at a time, and a
 * trigger for a loop that is already running or queued is skipped.
 */

import { Notice, normalizePath } from "obsidian";
import type LLMPlugin from "main";
import { logger } from "../utils/logger";
import { getErrorMessage } from "utils/errorUtils";
import { AgentLoop, AgentCallbacks, ToolGuard } from "services/AgentLoop";
import { ALL_TOOL_DEFINITIONS } from "services/ObsidianToolRegistry";
import { ChatHistory } from "services/ChatHistory";
import { createOpenAICompatibleClient } from "services/OpenAIClientFactory";
import { models, modelNames } from "utils/models";
import { claude, lmStudio, mistral, ollama, openAI } from "utils/constants";
import {
	Assistant,
	ChatParams,
	LoopRunStatus,
	LoopRuntimeState,
	LoopVerdict,
	Message,
	ToolCallRecord,
} from "Types/types";
import { LoopDefinition, OBSIDIAN_AGENT_WORKER } from "./LoopManager";

export type LoopRunReason = "manual" | "on-startup" | "interval";

export interface LoopRunResult {
	loopId: string;
	runNumber: number;
	status: LoopRunStatus;
	verdict: LoopVerdict;
	failReasons: string[];
	workerOutput: string;
	verifierOutput: string;
	toolCalls: ToolCallRecord[];
	draftsWritten: string[];
	inputTokens: number;
	outputTokens: number;
	error: string | null;
	logPath: string | null;
}

interface ResolvedModel {
	model: string;
	modelType: string;
	modelName: string;
}

interface AgentPassResult {
	text: string;
	toolCalls: ToolCallRecord[];
	inputTokens: number;
	outputTokens: number;
	budgetExceeded: boolean;
}

/** Tools never offered to a loop: UI-driving or arbitrary-execution tools. */
const LOOP_BLOCKED_TOOLS = ["obsidian_open_note", "obsidian_execute_command", "run_shell_command"];

const STATE_PROGRESS_START = "<!-- loop:progress:start -->";
const STATE_PROGRESS_END = "<!-- loop:progress:end -->";
const STATE_LAST_RUN_START = "<!-- loop:last-run:start -->";
const STATE_LAST_RUN_END = "<!-- loop:last-run:end -->";
const STATE_HISTORY_HEADING = "## Run history";
const MAX_HISTORY_ENTRIES = 50;
const MAX_DRAFT_CHARS_FOR_VERIFIER = 8000;

/** Deny-always permission callback — there is never a human to ask. */
const denyAll = (): Promise<boolean> => Promise.resolve(false);

export class LoopRunner {
	private queue: Array<{ loopId: string; reason: LoopRunReason }> = [];
	private currentLoopId: string | null = null;
	private currentController: AbortController | null = null;
	private draining = false;
	private listeners = new Set<() => void>();

	constructor(private plugin: LLMPlugin) {}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	isRunning(loopId: string): boolean {
		return this.currentLoopId === loopId;
	}

	isQueued(loopId: string): boolean {
		return this.queue.some((q) => q.loopId === loopId);
	}

	getState(loopId: string): LoopRuntimeState | null {
		return this.plugin.settings.loopSettings?.loops?.[loopId] ?? null;
	}

	/**
	 * Queue a run. Returns false (and does nothing) when the loop is already
	 * running or queued — triggers never stack up.
	 */
	enqueue(loopId: string, reason: LoopRunReason): boolean {
		if (this.isRunning(loopId) || this.isQueued(loopId)) {
			logger.log(`[LoopRunner] Skipping ${reason} trigger for "${loopId}" — already running or queued.`);
			return false;
		}
		this.queue.push({ loopId, reason });
		this.emit();
		void this.drain();
		return true;
	}

	/** Manual "Run now" with user feedback. */
	runNow(loopId: string): void {
		const loop = this.plugin.loopManager.getLoop(loopId);
		if (!loop) return;
		const busy = this.currentLoopId !== null;
		if (!this.enqueue(loopId, "manual")) {
			new Notice(`Loop "${loop.name}" is already running or queued.`);
		} else {
			new Notice(busy ? `Loop "${loop.name}" queued.` : `Loop "${loop.name}" started.`);
		}
	}

	/** Abort the running loop (if it matches) or drop it from the queue. */
	abort(loopId: string): void {
		const before = this.queue.length;
		this.queue = this.queue.filter((q) => q.loopId !== loopId);
		if (this.currentLoopId === loopId) this.currentController?.abort();
		if (before !== this.queue.length) this.emit();
	}

	abortAll(): void {
		this.queue = [];
		this.currentController?.abort();
		this.emit();
	}

	// ---------------------------------------------------------------------------
	// Queue
	// ---------------------------------------------------------------------------

	private async drain(): Promise<void> {
		if (this.draining) return;
		this.draining = true;
		try {
			while (this.queue.length > 0) {
				const next = this.queue.shift()!;
				const loop = this.plugin.loopManager.getLoop(next.loopId);
				if (!loop) continue;
				await this.runOnce(loop, next.reason);
			}
		} finally {
			this.draining = false;
		}
	}

	// ---------------------------------------------------------------------------
	// One run
	// ---------------------------------------------------------------------------

	/**
	 * Execute one worker (+ verifier) pass. Exposed for future goal mode, which
	 * will call this repeatedly until the goal is met or max_runs is reached.
	 * Callers outside the queue must not run two loops concurrently.
	 */
	async runOnce(loop: LoopDefinition, reason: LoopRunReason): Promise<LoopRunResult> {
		const controller = new AbortController();
		this.currentLoopId = loop.id;
		this.currentController = controller;

		const startedAt = Date.now();
		const prev = this.getState(loop.id);
		const runNumber = (prev?.runCount ?? 0) + 1;

		// Record lastRunAt up front so the interval scheduler can't re-fire this
		// loop while it is still running, even across a crash/restart.
		this.saveState(loop.id, {
			lastRunAt: startedAt,
			lastStatus: prev?.lastStatus ?? "ok",
			lastVerdict: prev?.lastVerdict ?? "none",
			lastFailReasons: prev?.lastFailReasons ?? [],
			runCount: runNumber,
		});
		await this.plugin.saveSettings();
		this.emit();

		const result: LoopRunResult = {
			loopId: loop.id,
			runNumber,
			status: "ok",
			verdict: "none",
			failReasons: [],
			workerOutput: "",
			verifierOutput: "",
			toolCalls: [],
			draftsWritten: [],
			inputTokens: 0,
			outputTokens: 0,
			error: null,
			logPath: null,
		};
		let modelLabel = "";

		try {
			// ── Resolve participants (fail fast before spending tokens) ─────────
			const workerAssistant = this.resolveAssistant(loop.worker, "worker");
			const verifierAssistant = loop.verifier ? this.resolveAssistant(loop.verifier, "verifier") : null;
			const skill = loop.skill ? this.plugin.skillRegistry?.getSkill(loop.skill) : undefined;
			if (loop.skill && !skill) throw new Error(`Skill "${loop.skill}" not found.`);

			const workerModel = this.resolveModel(loop.model, workerAssistant, loop.worker === OBSIDIAN_AGENT_WORKER);
			this.assertModelUsable(workerModel);
			modelLabel = workerModel.modelName;

			await this.ensureFolder(loop.folderPath);
			await this.ensureFolder(loop.runsFolder);
			await this.ensureFolder(loop.draftsFolder);
			const stateContent = await this.readOrCreateState(loop);

			// ── Worker ──────────────────────────────────────────────────────────
			const workerSystem = await this.buildWorkerContext(loop, stateContent, prev, workerAssistant, skill?.instructions ?? null);
			const workerTools = LoopRunner.intersectAllowed(skill?.allowedTools ?? [], workerAssistant?.allowedTools ?? []);
			const workerPrompt =
				`Run #${runNumber} of loop "${loop.name}" (trigger: ${reason}). ` +
				`Current time: ${new Date(startedAt).toISOString()}. ` +
				"Carry out the loop instructions now, then end with the ## Progress section.";

			const worker = await this.runAgentPass({
				loop,
				model: workerModel,
				systemContext: workerSystem,
				prompt: workerPrompt,
				permission: loop.permission,
				allowedTools: workerTools,
				maxToolCalls: loop.maxToolCalls,
				tokenBudget: loop.maxTokensPerRun,
				temperature: this.plugin.settings.widgetSettings.chatSettings.temperature,
				signal: controller.signal,
			});
			result.workerOutput = worker.text;
			result.toolCalls = worker.toolCalls;
			result.inputTokens += worker.inputTokens;
			result.outputTokens += worker.outputTokens;
			result.draftsWritten = LoopRunner.draftsFromToolCalls(worker.toolCalls, loop.draftsFolder);

			if (worker.budgetExceeded) result.status = "budget-exceeded";
			else if (controller.signal.aborted) result.status = "aborted";

			// ── Verifier (independent second pass, read-only) ───────────────────
			if (verifierAssistant && result.status === "ok") {
				const remaining = loop.maxTokensPerRun - (result.inputTokens + result.outputTokens);
				if (remaining <= 0) {
					result.status = "budget-exceeded";
				} else {
					const verifierModel = this.resolveModel(null, verifierAssistant, false, workerModel);
					this.assertModelUsable(verifierModel);
					const verifierSystem = await this.buildVerifierContext(loop, verifierAssistant, result);
					const verifier = await this.runAgentPass({
						loop,
						model: verifierModel,
						systemContext: verifierSystem,
						prompt: "Review the worker's run now and return your verdict in the required format.",
						permission: "read-only",
						allowedTools: verifierAssistant.allowedTools,
						maxToolCalls: loop.maxToolCalls,
						tokenBudget: remaining,
						temperature: 0,
						signal: controller.signal,
					});
					result.verifierOutput = verifier.text;
					result.inputTokens += verifier.inputTokens;
					result.outputTokens += verifier.outputTokens;
					if (verifier.budgetExceeded) {
						result.status = "budget-exceeded";
						result.verdict = "FAIL";
						result.failReasons = ["Token budget ran out before the verifier finished."];
					} else if (controller.signal.aborted) {
						result.status = "aborted";
					} else {
						const parsed = LoopRunner.parseVerdict(verifier.text);
						result.verdict = parsed.verdict;
						result.failReasons = parsed.reasons;
					}
				}
			}
		} catch (e) {
			if (controller.signal.aborted) {
				result.status = "aborted";
			} else {
				result.status = "error";
				result.error = getErrorMessage(e);
				logger.error(`[LoopRunner] Loop "${loop.id}" failed:`, e);
			}
		}

		// ── Persist: run log, STATE.md, runtime state ───────────────────────────
		const finishedAt = Date.now();
		try {
			result.logPath = await this.writeRunLog(loop, result, reason, startedAt, finishedAt, modelLabel);
		} catch (e) {
			logger.error(`[LoopRunner] Could not write run log for "${loop.id}":`, e);
		}
		try {
			await this.updateStateFile(loop, result, startedAt);
		} catch (e) {
			logger.error(`[LoopRunner] Could not update STATE.md for "${loop.id}":`, e);
		}

		// Outstanding verifier feedback survives runs that never reached the
		// verifier (error / aborted / over budget); only a new verdict replaces it.
		const failReasons =
			result.verdict === "FAIL" ? result.failReasons
			: result.verdict === "PASS" ? []
			: prev?.lastFailReasons ?? [];
		try {
			this.saveState(loop.id, {
				lastRunAt: startedAt,
				lastStatus: result.status,
				lastVerdict: result.verdict,
				lastFailReasons: failReasons,
				runCount: runNumber,
			});
			await this.plugin.saveSettings();
		} catch (e) {
			logger.error(`[LoopRunner] Could not save loop state for "${loop.id}":`, e);
		} finally {
			// Always release the slot, or the loop would read as running forever.
			this.currentLoopId = null;
			this.currentController = null;
			this.emit();
		}

		new Notice(LoopRunner.noticeText(loop, result), 8000);
		return result;
	}

	// ---------------------------------------------------------------------------
	// Agent pass
	// ---------------------------------------------------------------------------

	private async runAgentPass(opts: {
		loop: LoopDefinition;
		model: ResolvedModel;
		systemContext: string;
		prompt: string;
		permission: "read-only" | "staging";
		allowedTools: string[];
		maxToolCalls: number;
		tokenBudget: number;
		temperature: number;
		signal: AbortSignal;
	}): Promise<AgentPassResult> {
		const settings = this.plugin.settings;
		// A pass gets its own controller so the token budget can stop it without
		// being mistaken for a user abort; a user abort still propagates in.
		const passController = new AbortController();
		const onOuterAbort = () => passController.abort();
		opts.signal.addEventListener("abort", onOuterAbort);

		const out: AgentPassResult = { text: "", toolCalls: [], inputTokens: 0, outputTokens: 0, budgetExceeded: false };
		const disabledTools = [...(settings.toolSettings?.disabledTools ?? []), ...LOOP_BLOCKED_TOOLS];

		const agentLoop = new AgentLoop(
			this.plugin.app,
			opts.permission,
			denyAll,
			this.plugin.vaultIndexer,
			opts.allowedTools.length > 0 ? opts.allowedTools : undefined,
			disabledTools,
			opts.maxToolCalls,
			undefined, // no dynamic tools — see file header
			settings.chatHistoryEnabled ? this.plugin.chatHistory : undefined,
			this.plugin.searxngService,
			{
				toolGuard: LoopRunner.makeToolGuard(opts.loop.draftsFolder),
				// Mistral reports usage unprompted and may reject stream_options.
				requestUsage: opts.model.modelType !== mistral,
			},
		);

		const callbacks: AgentCallbacks = {
			onStart: () => { /* headless */ },
			onThinking: () => { /* headless */ },
			onChunk: (text) => { out.text += text; },
			onToolStart: (name) => logger.debug(`[LoopRunner] ${opts.loop.id}: running ${name}`),
			onToolResult: (name, input, result) => {
				out.toolCalls.push({ name, input, result });
			},
			onUsage: (inputTokens, outputTokens) => {
				out.inputTokens = inputTokens;
				out.outputTokens = outputTokens;
				if (inputTokens + outputTokens > opts.tokenBudget && !out.budgetExceeded) {
					out.budgetExceeded = true;
					logger.warn(`[LoopRunner] Loop "${opts.loop.id}" exceeded its token budget (${opts.tokenBudget}); stopping.`);
					passController.abort();
				}
			},
		};

		const { modelType, model } = opts.model;
		const messages: Message[] = [{ role: "user", content: opts.prompt }];
		const params: ChatParams = {
			prompt: opts.prompt,
			model,
			temperature: opts.temperature,
			tokens: settings.widgetSettings.chatSettings.maxTokens || undefined,
			// Anthropic takes the system prompt as a parameter; OpenAI-compatible
			// providers get it as a leading system message.
			...(modelType === claude
				? { systemContext: opts.systemContext, messages }
				: { messages: [{ role: "system", content: opts.systemContext }, ...messages] }),
		};

		try {
			if (modelType === claude) {
				await agentLoop.runAnthropic(params, settings.claudeAPIKey, callbacks, passController.signal);
			} else {
				const client = createOpenAICompatibleClient(settings, modelType);
				await agentLoop.runOpenAICompatible(params, client, callbacks, passController.signal);
			}
		} catch (e) {
			// A budget stop can surface as an AbortError from an in-flight request.
			if (!out.budgetExceeded) throw e;
		} finally {
			opts.signal.removeEventListener("abort", onOuterAbort);
		}
		return out;
	}

	/**
	 * Build the ToolGuard that confines writes to `draftsFolder`. Applied to
	 * both read-only and staging passes (read-only denies writes anyway, so the
	 * guard is defence in depth there).
	 */
	static makeToolGuard(draftsFolder: string): ToolGuard {
		const prefix = normalizePath(draftsFolder) + "/";
		return (toolName, input) => {
			if (LOOP_BLOCKED_TOOLS.includes(toolName)) return `${toolName} is not available in loop runs.`;
			const def = ALL_TOOL_DEFINITIONS.find((t) => t.name === toolName);
			if (!def) return `Unknown tool ${toolName} is not available in loop runs.`;
			if (def.risk === "safe") return null;
			if (def.risk === "danger") return `${toolName} is not available in loop runs.`;
			// write-tier: the target path must live inside drafts/
			const raw = input.path;
			if (typeof raw !== "string" || !LoopRunner.isInsideFolder(raw, prefix)) {
				return `loops may only create or modify files inside ${prefix}`;
			}
			return null;
		};
	}

	/** True when `rawPath` resolves inside `prefix` (which ends in "/"). */
	static isInsideFolder(rawPath: string, prefix: string): boolean {
		if (rawPath.includes("\\")) return false;
		if (rawPath.split("/").some((seg) => seg === "..")) return false;
		const p = normalizePath(rawPath);
		return p.startsWith(prefix) && p.length > prefix.length;
	}

	// ---------------------------------------------------------------------------
	// Context builders
	// ---------------------------------------------------------------------------

	/** Order: STATE.md → worker prompt → skill instructions → LOOP.md body → run rules. */
	private async buildWorkerContext(
		loop: LoopDefinition,
		stateContent: string,
		prev: LoopRuntimeState | null,
		worker: Assistant | null,
		skillInstructions: string | null,
	): Promise<string> {
		const parts: string[] = [];

		let stateBlock = `# Loop state (${loop.statePath})\n\n${stateContent.trim() || "_No previous runs._"}`;
		if (prev?.lastFailReasons?.length) {
			stateBlock +=
				"\n\n## The verifier rejected the previous run\n\nAddress these problems in this run:\n" +
				prev.lastFailReasons.map((r) => `- ${r}`).join("\n");
		}
		parts.push(stateBlock);

		if (worker) {
			parts.push(`# Assistant: ${worker.name}\n\n${worker.systemPrompt}`);
		} else {
			parts.push(await this.plugin.obsidianAgent.buildSystemPrompt());
		}

		if (skillInstructions) parts.push(`# Skill: ${loop.skill}\n\n${skillInstructions}`);

		parts.push(`# Loop instructions: ${loop.name}\n\n${loop.instructions || "_(LOOP.md has no instructions.)_"}`);

		const writeRule =
			loop.permission === "staging"
				? `You may create or modify files ONLY inside \`${loop.draftsFolder}/\`. Any write outside it will be denied. Put all proposed changes there as draft notes for the user to review.`
				: "This loop is read-only: every write will be denied. Report your findings in your reply.";
		parts.push(
			"# Run rules\n\n" +
			"This is an unattended, scheduled run. No human is watching and nobody can approve tool calls or answer questions — never ask for confirmation; do the work or explain why you could not.\n\n" +
			`${writeRule}\n\n` +
			"Do not try to edit STATE.md, guidance files, settings, skills, or memories — the runner maintains STATE.md from your reply.\n\n" +
			"End your reply with this exact section so the runner can update STATE.md:\n\n" +
			"## Progress\n### Done\n- …\n### Pending\n- …\n### Next\n- …"
		);

		return parts.join("\n\n---\n\n");
	}

	private async buildVerifierContext(loop: LoopDefinition, verifier: Assistant, run: LoopRunResult): Promise<string> {
		const drafts: string[] = [];
		for (const path of run.draftsWritten.slice(0, 10)) {
			try {
				if (!(await this.plugin.app.vault.adapter.exists(path))) continue;
				let body = await this.plugin.app.vault.adapter.read(path);
				if (body.length > MAX_DRAFT_CHARS_FOR_VERIFIER) body = body.slice(0, MAX_DRAFT_CHARS_FOR_VERIFIER) + "\n…(truncated)";
				drafts.push(`### ${path}\n\n\`\`\`markdown\n${body}\n\`\`\``);
			} catch { /* skip unreadable draft */ }
		}
		const toolSummary = run.toolCalls.length
			? run.toolCalls.map((t) => `- ${t.name} ${JSON.stringify(t.input).slice(0, 200)}`).join("\n")
			: "_No tool calls._";

		return [
			`# Assistant: ${verifier.name}\n\n${verifier.systemPrompt}`,
			"# Verification task\n\n" +
			"You are an independent verifier. A separate worker agent just ran the loop below. " +
			"Judge whether its run correctly and completely followed the loop instructions. " +
			"You have read-only tools — use them to check the worker's claims against the vault. " +
			"Be strict: PASS only if the work is correct and complete.",
			`## Loop instructions (${loop.name})\n\n${loop.instructions}`,
			`## Worker output\n\n${run.workerOutput || "_(empty)_"}`,
			`## Worker tool calls\n\n${toolSummary}`,
			`## Drafts written this run\n\n${drafts.length ? drafts.join("\n\n") : "_None._"}`,
			"## Required response format\n\n" +
			"End your reply with exactly:\n\nVERDICT: PASS\n\nor\n\nVERDICT: FAIL\nREASONS:\n- <reason>\n- <reason>",
		].join("\n\n---\n\n");
	}

	// ---------------------------------------------------------------------------
	// Resolution helpers
	// ---------------------------------------------------------------------------

	private resolveAssistant(id: string, role: "worker" | "verifier"): Assistant | null {
		if (role === "worker" && id === OBSIDIAN_AGENT_WORKER) return null;
		const a = this.plugin.assistantManager?.getAssistant(id);
		if (!a) throw new Error(`${role === "worker" ? "Worker" : "Verifier"} assistant "${id}" not found.`);
		return a;
	}

	/**
	 * Model priority: LOOP.md `model:` → assistant `preferred-model` →
	 * Obsidian Agent default model (worker only) → `fallback` → chat widget model.
	 */
	private resolveModel(
		override: string | null,
		assistant: Assistant | null,
		isObsidianAgent: boolean,
		fallback?: ResolvedModel,
	): ResolvedModel {
		const lookup = (value: string | null | undefined): ResolvedModel | null => {
			if (!value) return null;
			const name = modelNames[value] ?? (models[value] ? value : undefined);
			if (!name || !models[name]) return null;
			return { model: models[name].model, modelType: models[name].type, modelName: name };
		};
		if (override) {
			const m = lookup(override);
			if (!m) throw new Error(`Model "${override}" in LOOP.md is not a known model id.`);
			return m;
		}
		const candidate =
			lookup(assistant?.preferredModel) ??
			(isObsidianAgent ? lookup(this.plugin.settings.obsidianAgentSettings?.defaultModel) : null);
		if (candidate) return candidate;
		if (fallback) return fallback;
		const ws = this.plugin.settings.widgetSettings;
		return lookup(ws.model) ?? { model: ws.model, modelType: ws.modelType, modelName: ws.modelName };
	}

	private assertModelUsable(m: ResolvedModel): void {
		const s = this.plugin.settings;
		const supported = [claude, openAI, mistral, ollama, lmStudio];
		if (!supported.includes(m.modelType)) {
			throw new Error(`Model "${m.modelName}" (${m.modelType}) can't run tools. Loops need a Claude, OpenAI, Mistral, Ollama, or LM Studio model — set \`model:\` in LOOP.md.`);
		}
		if (m.modelType === claude && !s.claudeAPIKey) throw new Error("No Claude API key configured. Add one in Settings → Anthropic.");
		if (m.modelType === openAI && !s.openAIAPIKey) throw new Error("No OpenAI API key configured. Add one in Settings → OpenAI.");
		if (m.modelType === mistral && !s.mistralAPIKey) throw new Error("No Mistral API key configured. Add one in Settings → Mistral.");
	}

	/** Intersect two allow-lists where empty means "everything". */
	private static intersectAllowed(a: string[], b: string[]): string[] {
		if (a.length === 0) return b;
		if (b.length === 0) return a;
		const inter = a.filter((t) => b.includes(t));
		// An empty result would read as "all tools" — refuse instead.
		if (inter.length === 0) throw new Error("The skill's allowed-tools and the worker assistant's allowed-tools have no tools in common.");
		return inter;
	}

	private static draftsFromToolCalls(calls: ToolCallRecord[], draftsFolder: string): string[] {
		const prefix = normalizePath(draftsFolder) + "/";
		const out = new Set<string>();
		for (const c of calls) {
			const def = ALL_TOOL_DEFINITIONS.find((t) => t.name === c.name);
			if (def?.risk !== "write" || typeof c.input.path !== "string") continue;
			const p = normalizePath(c.input.path);
			if (p.startsWith(prefix)) out.add(p);
		}
		return [...out];
	}

	/** Parse the verifier's `VERDICT:` / `REASONS:` block. Unparseable → FAIL. */
	static parseVerdict(text: string): { verdict: LoopVerdict; reasons: string[] } {
		const matches = [...text.matchAll(/VERDICT:\s*\**\s*(PASS|FAIL)\b/gi)];
		if (matches.length === 0) {
			return { verdict: "FAIL", reasons: ["The verifier did not return a parseable VERDICT line."] };
		}
		const last = matches[matches.length - 1];
		const verdict = last[1].toUpperCase() as "PASS" | "FAIL";
		const reasons: string[] = [];
		const after = text.slice((last.index ?? 0) + last[0].length);
		const reasonsIdx = after.search(/REASONS:/i);
		if (reasonsIdx >= 0) {
			for (const line of after.slice(reasonsIdx).split(/\r?\n/).slice(1)) {
				const m = line.match(/^\s*[-*]\s+(.+)$/);
				if (m) reasons.push(m[1].trim());
				else if (line.trim() && reasons.length > 0) break;
			}
		}
		if (verdict === "FAIL" && reasons.length === 0) reasons.push("The verifier returned FAIL without reasons.");
		return { verdict, reasons };
	}

	// ---------------------------------------------------------------------------
	// Files
	// ---------------------------------------------------------------------------

	private async ensureFolder(path: string): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		if (!(await adapter.exists(path))) await adapter.mkdir(path);
	}

	private async readOrCreateState(loop: LoopDefinition): Promise<string> {
		const adapter = this.plugin.app.vault.adapter;
		if (await adapter.exists(loop.statePath)) return adapter.read(loop.statePath);
		const initial =
			`# ${loop.name} — state\n\n` +
			`${STATE_PROGRESS_START}\n## Progress\n_Nothing yet — the first run will fill this in._\n${STATE_PROGRESS_END}\n\n` +
			`${STATE_LAST_RUN_START}\n${STATE_LAST_RUN_END}\n\n` +
			`${STATE_HISTORY_HEADING}\n`;
		await adapter.write(loop.statePath, initial);
		return initial;
	}

	private static runFileName(startedAt: number, runNumber: number): string {
		// 2026-09-25T10-30-00Z-run7 — sortable, filesystem-safe, unique per loop
		// (the run number disambiguates runs that start in the same second).
		const ts = new Date(startedAt).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
		return `${ts}-run${runNumber}`;
	}

	private async writeRunLog(
		loop: LoopDefinition,
		r: LoopRunResult,
		reason: LoopRunReason,
		startedAt: number,
		finishedAt: number,
		modelLabel: string,
	): Promise<string> {
		const adapter = this.plugin.app.vault.adapter;
		await this.ensureFolder(loop.folderPath);
		await this.ensureFolder(loop.runsFolder);
		const path = normalizePath(`${loop.runsFolder}/${LoopRunner.runFileName(startedAt, r.runNumber)}.md`);

		const fm = [
			"---",
			`loop: ${loop.id}`,
			`run: ${r.runNumber}`,
			`trigger: ${reason}`,
			`started: ${new Date(startedAt).toISOString()}`,
			`duration_ms: ${finishedAt - startedAt}`,
			`status: ${r.status}`,
			`verdict: ${r.verdict}`,
			`model: "${modelLabel}"`,
			`input_tokens: ${r.inputTokens}`,
			`output_tokens: ${r.outputTokens}`,
			"---",
		].join("\n");

		let body = `\n# ${loop.name} — run ${r.runNumber}\n\n`;
		if (r.error) body += `> [!failure] Error\n> ${r.error.replace(/\n/g, "\n> ")}\n\n`;
		if (loop.warnings.length) body += `> [!warning] LOOP.md warnings\n${loop.warnings.map((w) => `> - ${w}`).join("\n")}\n\n`;

		body += "## Worker\n\n";
		if (r.toolCalls.length) body += ChatHistory.renderToolCallBlock(r.toolCalls);
		body += `${r.workerOutput.trim() || "_No output._"}\n\n`;

		body += "## Drafts written\n\n";
		body += r.draftsWritten.length ? r.draftsWritten.map((p) => `- [[${p.replace(/\.md$/, "")}]]`).join("\n") + "\n\n" : "_None._\n\n";

		if (loop.verifier) {
			body += "## Verifier\n\n";
			if (r.verdict === "none") {
				body += `_Skipped — worker status was ${r.status}._\n`;
			} else {
				const type = r.verdict === "PASS" ? "success" : "failure";
				body += `> [!${type}] Verdict: ${r.verdict}\n`;
				if (r.failReasons.length) body += r.failReasons.map((x) => `> - ${x}`).join("\n") + "\n";
				body += `\n${r.verifierOutput.trim()}\n`;
			}
		}

		await adapter.write(path, fm + "\n" + body);
		return path;
	}

	private async updateStateFile(loop: LoopDefinition, r: LoopRunResult, startedAt: number): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		await this.ensureFolder(loop.folderPath);
		let content = await this.readOrCreateState(loop);

		// Progress: replace only when the worker produced a ## Progress section.
		const progressIdx = r.workerOutput.search(/^##\s+Progress\s*$/m);
		if (progressIdx >= 0) {
			content = LoopRunner.replaceBlock(content, STATE_PROGRESS_START, STATE_PROGRESS_END, r.workerOutput.slice(progressIdx).trim());
		}

		const when = new Date(startedAt).toISOString();
		const logLink = r.logPath ? `[[${r.logPath.replace(/\.md$/, "")}|run ${r.runNumber}]]` : `run ${r.runNumber}`;
		const lastRun: string[] = [
			"## Last run",
			`- When: ${when}`,
			`- Status: ${r.status}${r.error ? ` — ${r.error}` : ""}`,
			`- Verdict: ${r.verdict}`,
			`- Log: ${logLink}`,
		];
		if (r.verdict === "FAIL" && r.failReasons.length) {
			lastRun.push("- Verifier reasons (carried into the next run):");
			for (const reason of r.failReasons) lastRun.push(`  - ${reason}`);
		}
		content = LoopRunner.replaceBlock(content, STATE_LAST_RUN_START, STATE_LAST_RUN_END, lastRun.join("\n"));

		// Append to run history, keeping only the newest MAX_HISTORY_ENTRIES.
		// Only runner-written entries (`- <ISO timestamp> · …`) are pruned or
		// moved; any other lines in the section, and every later section, are kept.
		const entry = `- ${when} · ${logLink} · ${r.status} · ${r.verdict}`;
		const hIdx = content.indexOf(STATE_HISTORY_HEADING);
		if (hIdx < 0) {
			content = content.trimEnd() + `\n\n${STATE_HISTORY_HEADING}\n${entry}\n`;
		} else {
			const head = content.slice(0, hIdx + STATE_HISTORY_HEADING.length);
			const afterHeading = content.slice(hIdx + STATE_HISTORY_HEADING.length);
			const nextHeading = afterHeading.search(/\n#{1,2} /);
			const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
			const rest = nextHeading >= 0 ? afterHeading.slice(nextHeading) : "";
			const isEntry = (l: string) => /^- \d{4}-\d{2}-\d{2}T/.test(l);
			const lines = section.split("\n");
			const entries = [...lines.filter(isEntry), entry].slice(-MAX_HISTORY_ENTRIES);
			const other = lines.filter((l) => !isEntry(l)).join("\n").trim();
			content = `${head}\n${entries.join("\n")}\n${other ? `\n${other}\n` : ""}${rest ? rest.replace(/^\n*/, "\n") : ""}`;
			if (!content.endsWith("\n")) content += "\n";
		}

		await adapter.write(loop.statePath, content);
	}

	/** Replace text between markers, inserting the block before the history heading if missing. */
	private static replaceBlock(content: string, start: string, end: string, inner: string): string {
		const s = content.indexOf(start);
		const e = content.indexOf(end);
		const block = `${start}\n${inner}\n${end}`;
		if (s >= 0 && e > s) return content.slice(0, s) + block + content.slice(e + end.length);
		const h = content.indexOf(STATE_HISTORY_HEADING);
		if (h >= 0) return content.slice(0, h) + block + "\n\n" + content.slice(h);
		return content.trimEnd() + "\n\n" + block + "\n";
	}

	// ---------------------------------------------------------------------------
	// Misc
	// ---------------------------------------------------------------------------

	private saveState(loopId: string, state: LoopRuntimeState): void {
		if (!this.plugin.settings.loopSettings) this.plugin.settings.loopSettings = { loops: {} };
		this.plugin.settings.loopSettings.loops[loopId] = state;
	}

	private static noticeText(loop: LoopDefinition, r: LoopRunResult): string {
		if (r.status === "error") return `Loop "${loop.name}" failed: ${r.error ?? "unknown error"}`;
		if (r.status === "aborted") return `Loop "${loop.name}" was stopped.`;
		if (r.status === "budget-exceeded") return `Loop "${loop.name}" stopped: token budget (${loop.maxTokensPerRun}) exceeded.`;
		if (r.verdict === "PASS") return `Loop "${loop.name}" finished — verifier: PASS`;
		if (r.verdict === "FAIL") return `Loop "${loop.name}" finished — verifier: FAIL (${r.failReasons.length} reason${r.failReasons.length === 1 ? "" : "s"})`;
		return `Loop "${loop.name}" finished.`;
	}

	private emit(): void {
		for (const l of this.listeners) {
			try { l(); } catch (e) { logger.error("[LoopRunner] listener failed:", e); }
		}
	}
}
