/**
 * LoopManager — discovers, parses, and hot-reloads LOOP.md files from the
 * <rootVaultFolder>/Loops/ folder (same adapter-based pattern as
 * SkillRegistry / AssistantManager).
 *
 * Each loop lives at: <rootVaultFolder>/Loops/<loop-id>/LOOP.md
 * alongside the files the runner maintains:
 *   STATE.md          — progress, read by the worker, updated by the runner
 *   runs/<ts>.md      — one log per run
 *   drafts/           — the only place a `staging` loop may write
 *
 * LOOP.md format:
 * ---
 * name: Daily issue triage
 * description: Triage new notes in Issues/
 * enabled: true
 * trigger: manual            # manual | on-startup | interval
 * interval: 24h              # m / h / d; used when trigger: interval
 * skill: triage-issues       # optional SKILL.md id
 * worker: obsidian-agent     # optional assistant id; default = Obsidian Agent
 * verifier: reviewer         # optional assistant id; omit = no verification
 * permission: staging        # read-only | staging
 * max_tool_calls: 15
 * max_tokens_per_run: 50000
 * model: claude-sonnet-4-6   # optional model id override
 * ---
 * Per-run instructions for the worker...
 */

import { App, normalizePath } from "obsidian";
import { logger } from "../utils/logger";

export type LoopTrigger = "manual" | "on-startup" | "interval";
export type LoopPermission = "read-only" | "staging";

/** Worker id meaning "use the Obsidian Agent system prompt". */
export const OBSIDIAN_AGENT_WORKER = "obsidian-agent";

const DEFAULT_MAX_TOOL_CALLS = 15;
const DEFAULT_MAX_TOKENS_PER_RUN = 50_000;
const MIN_INTERVAL_MS = 60_000;

export interface LoopDefinition {
	/** Folder name — unique key. */
	id: string;
	name: string;
	description: string;
	/** When false, triggers never fire; "Run now" still works. */
	enabled: boolean;
	trigger: LoopTrigger;
	/** Raw `interval:` value, e.g. "24h". */
	intervalRaw: string;
	/** Parsed interval in ms; null when missing/invalid. */
	intervalMs: number | null;
	skill: string | null;
	/** Assistant id, or OBSIDIAN_AGENT_WORKER. */
	worker: string;
	verifier: string | null;
	permission: LoopPermission;
	maxToolCalls: number;
	maxTokensPerRun: number;
	/** Optional model id override (a key of `modelNames`). */
	model: string | null;
	/** Non-fatal parse problems, surfaced in the UI and the run log. */
	warnings: string[];
	/** LOOP.md path. */
	filePath: string;
	/** Loop folder (parent of LOOP.md). */
	folderPath: string;
	statePath: string;
	runsFolder: string;
	draftsFolder: string;
	/** Body of LOOP.md — the per-run instructions. */
	instructions: string;
}

export class LoopManager {
	private loops: Map<string, LoopDefinition> = new Map();
	private loopsFolder = "AI/Loops";
	private listeners = new Set<() => void>();

	constructor(private app: App) {}

	// ---------------------------------------------------------------------------
	// Public API
	// ---------------------------------------------------------------------------

	getLoops(): LoopDefinition[] {
		return Array.from(this.loops.values()).sort((a, b) => a.name.localeCompare(b.name));
	}

	getLoop(id: string): LoopDefinition | null {
		return this.loops.get(id) ?? null;
	}

	getFolder(): string {
		return this.loopsFolder;
	}

	/** Subscribe to add/remove/reload events. Returns an unsubscribe function. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async setFolder(folder: string): Promise<void> {
		this.loopsFolder = normalizePath(folder);
		await this.reloadAll();
	}

	async reloadAll(): Promise<void> {
		this.loops.clear();
		let listing: { folders: string[]; files: string[] };
		try {
			listing = await this.app.vault.adapter.list(this.loopsFolder);
		} catch {
			// Folder doesn't exist yet — nothing to load
			this.emit();
			return;
		}
		for (const subFolder of listing.folders) {
			const candidate = `${subFolder}/LOOP.md`;
			if (await this.app.vault.adapter.exists(candidate)) {
				await this.loadLoopByPath(candidate, false);
			}
		}
		this.emit();
	}

	async loadLoopByPath(filePath: string, notify = true): Promise<void> {
		try {
			if (!(await this.app.vault.adapter.exists(filePath))) return;
			const raw = await this.app.vault.adapter.read(filePath);
			const loop = LoopManager.parseLoopFile(raw, filePath, this.loopsFolder);
			if (loop) {
				this.loops.set(loop.id, loop);
				logger.log(`[LoopManager] Loaded loop: ${loop.id} (${loop.name})`);
			}
		} catch (e) {
			logger.error(`[LoopManager] Failed to parse ${filePath}:`, e);
		}
		if (notify) this.emit();
	}

	removeByPath(filePath: string): void {
		for (const [id, loop] of this.loops) {
			if (loop.filePath === filePath) {
				this.loops.delete(id);
				this.emit();
				return;
			}
		}
	}

	/** True only for <loopsFolder>/<id>/LOOP.md — never for runs/, drafts/, or STATE.md. */
	isLoopFile(path: string): boolean {
		const prefix = this.loopsFolder + "/";
		if (!path.startsWith(prefix)) return false;
		const parts = path.slice(prefix.length).split("/");
		return parts.length === 2 && parts[1] === "LOOP.md";
	}

	/**
	 * Persist the enabled flag by rewriting (or inserting) the `enabled:` line in
	 * LOOP.md, so the file stays the single source of truth. Hot-reload picks up
	 * the change via the vault modify event; the in-memory copy is updated
	 * immediately so the UI doesn't flicker.
	 */
	async setEnabled(id: string, enabled: boolean): Promise<void> {
		const loop = this.loops.get(id);
		if (!loop) return;
		const raw = await this.app.vault.adapter.read(loop.filePath);
		const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		let next: string;
		if (!fm) {
			next = `---\nenabled: ${enabled}\n---\n${raw}`;
		} else {
			// Splice by offset (not string search) so an empty or repeated
			// frontmatter body can't redirect the edit elsewhere in the file.
			const fmStart = fm[0].indexOf("\n") + 1;
			const fmEnd = fmStart + fm[1].length;
			const newFm = /^enabled:.*$/m.test(fm[1])
				? fm[1].replace(/^enabled:.*$/m, `enabled: ${enabled}`)
				: fm[1].trim() === ""
					? `enabled: ${enabled}`
					: `${fm[1]}\nenabled: ${enabled}`;
			next = raw.slice(0, fmStart) + newFm + raw.slice(fmEnd);
		}
		await this.app.vault.adapter.write(loop.filePath, next);
		loop.enabled = enabled;
		this.emit();
	}

	// ---------------------------------------------------------------------------
	// Parsing
	// ---------------------------------------------------------------------------

	/** Parse "30m" / "6h" / "1d" (also "1.5h") into ms. Returns null when invalid. */
	static parseInterval(raw: string): number | null {
		const m = raw.trim().match(/^(\d+(?:\.\d+)?)\s*(m|h|d)$/i);
		if (!m) return null;
		const n = parseFloat(m[1]);
		const unit = m[2].toLowerCase();
		const ms = n * (unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
		return ms >= MIN_INTERVAL_MS ? ms : null;
	}

	static parseLoopFile(raw: string, filePath: string, loopsFolder: string): LoopDefinition | null {
		const prefix = loopsFolder.endsWith("/") ? loopsFolder : loopsFolder + "/";
		if (!filePath.startsWith(prefix)) return null;
		const id = filePath.slice(prefix.length).split("/")[0];
		if (!id) return null;
		const folderPath = `${prefix}${id}`;

		const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
		const fm = fmMatch ? fmMatch[1] : "";
		const body = (fmMatch ? fmMatch[2] : raw).trim();
		const warnings: string[] = [];

		const triggerRaw = (LoopManager.yamlString(fm, "trigger") ?? "manual").toLowerCase();
		let trigger: LoopTrigger = "manual";
		if (triggerRaw === "manual" || triggerRaw === "on-startup" || triggerRaw === "interval") {
			trigger = triggerRaw;
		} else {
			warnings.push(`Unknown trigger "${triggerRaw}" — treated as manual.`);
		}

		const intervalRaw = LoopManager.yamlString(fm, "interval") ?? "";
		const intervalMs = intervalRaw ? LoopManager.parseInterval(intervalRaw) : null;
		if (trigger === "interval" && intervalMs === null) {
			warnings.push(`trigger: interval needs a valid interval (e.g. 30m, 6h, 1d; minimum 1m) — got "${intervalRaw}".`);
		}

		const permRaw = (LoopManager.yamlString(fm, "permission") ?? "read-only").toLowerCase();
		let permission: LoopPermission = "read-only";
		if (permRaw === "staging" || permRaw === "read-only") {
			permission = permRaw;
		} else {
			warnings.push(`Unsupported permission "${permRaw}" — loops only allow read-only or staging; using read-only.`);
		}

		return {
			id,
			name: LoopManager.yamlString(fm, "name") ?? id,
			description: LoopManager.yamlString(fm, "description") ?? "",
			enabled: LoopManager.yamlBoolean(fm, "enabled") ?? true,
			trigger,
			intervalRaw,
			intervalMs,
			skill: LoopManager.yamlString(fm, "skill") || null,
			worker: LoopManager.yamlString(fm, "worker") || OBSIDIAN_AGENT_WORKER,
			verifier: LoopManager.yamlString(fm, "verifier") || null,
			permission,
			maxToolCalls: LoopManager.yamlPositiveInt(fm, "max_tool_calls") ?? DEFAULT_MAX_TOOL_CALLS,
			maxTokensPerRun: LoopManager.yamlPositiveInt(fm, "max_tokens_per_run") ?? DEFAULT_MAX_TOKENS_PER_RUN,
			model: LoopManager.yamlString(fm, "model") || null,
			warnings,
			filePath,
			folderPath,
			statePath: `${folderPath}/STATE.md`,
			runsFolder: `${folderPath}/runs`,
			draftsFolder: `${folderPath}/drafts`,
			instructions: body,
		};
	}

	private emit(): void {
		for (const l of this.listeners) {
			try { l(); } catch (e) { logger.error("[LoopManager] listener failed:", e); }
		}
	}

	// ---------------------------------------------------------------------------
	// Minimal YAML field extractors (no external deps)
	// ---------------------------------------------------------------------------

	private static yamlString(yaml: string, key: string): string | null {
		const m = yaml.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
		if (!m) return null;
		const value = m[1].trim();
		// Quoted scalar: keep everything between the quotes (a "#" inside is literal).
		const quoted = value.match(/^(["'])(.*)\1/);
		if (quoted) return quoted[2];
		// Plain scalar: " #" starts a comment, as in YAML.
		return value.replace(/\s+#.*$/, "").trim();
	}

	private static yamlBoolean(yaml: string, key: string): boolean | null {
		const v = LoopManager.yamlString(yaml, key);
		if (v === null || v === "") return null;
		return /^(true|yes|on)$/i.test(v);
	}

	private static yamlPositiveInt(yaml: string, key: string): number | null {
		const v = LoopManager.yamlString(yaml, key);
		if (!v) return null;
		const n = parseInt(v.replace(/[_,]/g, ""), 10);
		return Number.isFinite(n) && n > 0 ? n : null;
	}
}
