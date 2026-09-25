/**
 * LoopsContainer — the Loops list shown in Settings → Loops.
 *
 * One native `tree-item` row per loop: name, trigger, last run, verdict tag,
 * enabled toggle, Run now / Stop, and buttons to open LOOP.md and STATE.md.
 * Re-renders itself when loops are added/changed or a run starts/finishes, and
 * unsubscribes once its element has been removed from the DOM.
 */

import { ExtraButtonComponent, Notice, TFile, ToggleComponent, setIcon } from "obsidian";
import type LLMPlugin from "main";
import { LoopDefinition } from "Loops/LoopManager";

/** "3h ago" / "in 21h" — coarse, single-unit relative time. */
function relativeTime(ts: number, now = Date.now()): string {
	const diff = ts - now;
	const abs = Math.abs(diff);
	const units: Array<[number, string]> = [[86_400_000, "d"], [3_600_000, "h"], [60_000, "m"]];
	let label = "just now";
	for (const [ms, suffix] of units) {
		if (abs >= ms) {
			label = `${Math.floor(abs / ms)}${suffix}`;
			break;
		}
	}
	if (label === "just now") return label;
	return diff < 0 ? `${label} ago` : `in ${label}`;
}

export class LoopsContainer {
	private listEl: HTMLElement | null = null;
	private unsubscribers: Array<() => void> = [];

	constructor(private plugin: LLMPlugin) {}

	render(parent: HTMLElement): void {
		this.listEl = parent.createDiv({ cls: "llm-loop-list" });
		const rerender = () => {
			if (!this.listEl?.isConnected) {
				this.dispose();
				return;
			}
			this.renderList();
		};
		this.unsubscribers.push(this.plugin.loopManager.onChange(rerender));
		this.unsubscribers.push(this.plugin.loopRunner.onChange(rerender));
		this.renderList();
	}

	dispose(): void {
		for (const u of this.unsubscribers) u();
		this.unsubscribers = [];
	}

	private renderList(): void {
		const el = this.listEl;
		if (!el) return;
		el.empty();

		const loops = this.plugin.loopManager.getLoops();
		if (loops.length === 0) {
			el.createDiv({
				cls: "pane-empty",
				text: `No loops yet. Create ${this.plugin.loopsFolder}/<loop-name>/LOOP.md to add one.`,
			});
			return;
		}
		for (const loop of loops) this.renderRow(el, loop);
	}

	private renderRow(parent: HTMLElement, loop: LoopDefinition): void {
		const runner = this.plugin.loopRunner;
		const state = runner.getState(loop.id);
		const running = runner.isRunning(loop.id);
		const queued = runner.isQueued(loop.id);

		const item = parent.createDiv({ cls: "tree-item llm-loop-item" });
		const self = item.createDiv({ cls: "tree-item-self llm-loop-row" });
		self.toggleClass("llm-loop-disabled", !loop.enabled);

		const icon = self.createDiv({ cls: "tree-item-icon" });
		setIcon(icon, running ? "loader" : "repeat");

		const inner = self.createDiv({ cls: "tree-item-inner llm-loop-info" });
		inner.createDiv({ cls: "llm-loop-name", text: loop.name });

		const meta: string[] = [this.triggerLabel(loop)];
		if (running) meta.push("running…");
		else if (queued) meta.push("queued");
		else meta.push(state?.lastRunAt ? `last run ${relativeTime(state.lastRunAt)}` : "never run");
		const next = this.plugin.loopScheduler.nextRunAt(loop);
		if (next !== null && loop.enabled && !running && !queued) {
			meta.push(next <= Date.now() ? "due now" : `next ${relativeTime(next)}`);
		}
		inner.createDiv({ cls: "llm-loop-meta", text: meta.join(" · ") });
		for (const w of loop.warnings) inner.createDiv({ cls: "llm-loop-warning", text: w });

		const flairOuter = self.createDiv({ cls: "tree-item-flair-outer llm-loop-actions" });

		const verdict = this.verdictLabel(loop, state?.lastStatus, state?.lastVerdict);
		if (verdict) {
			const tag = flairOuter.createSpan({ cls: `tag llm-loop-verdict llm-loop-verdict-${verdict.kind}`, text: verdict.text });
			if (state?.lastFailReasons?.length) tag.setAttr("aria-label", state.lastFailReasons.join("\n"));
		}

		const toggle = new ToggleComponent(flairOuter);
		toggle.setValue(loop.enabled).setTooltip(loop.enabled ? "Triggers enabled" : "Triggers disabled");
		toggle.onChange(async (value) => {
			await this.plugin.loopManager.setEnabled(loop.id, value);
		});

		new ExtraButtonComponent(flairOuter)
			.setIcon(running || queued ? "square" : "play")
			.setTooltip(running ? "Stop run" : queued ? "Remove from queue" : "Run now")
			.onClick(() => {
				if (running || queued) runner.abort(loop.id);
				else runner.runNow(loop.id);
			});

		new ExtraButtonComponent(flairOuter)
			.setIcon("list-checks")
			.setTooltip("Open STATE.md")
			.onClick(() => void this.openFile(loop.statePath, "STATE.md is created on the first run."));

		new ExtraButtonComponent(flairOuter)
			.setIcon("pencil")
			.setTooltip("Edit LOOP.md")
			.onClick(() => void this.openFile(loop.filePath));
	}

	private triggerLabel(loop: LoopDefinition): string {
		if (loop.trigger === "interval") return loop.intervalMs ? `every ${loop.intervalRaw}` : "interval (invalid)";
		if (loop.trigger === "on-startup") return "on startup";
		return "manual";
	}

	private verdictLabel(
		loop: LoopDefinition,
		status: string | undefined,
		verdict: string | undefined,
	): { text: string; kind: string } | null {
		if (!status) return null;
		if (status === "error") return { text: "Error", kind: "error" };
		if (status === "aborted") return { text: "Stopped", kind: "muted" };
		if (status === "budget-exceeded") return { text: "Over budget", kind: "error" };
		if (verdict === "PASS") return { text: "PASS", kind: "pass" };
		if (verdict === "FAIL") return { text: "FAIL", kind: "fail" };
		return loop.verifier ? null : { text: "Done", kind: "muted" };
	}

	private async openFile(path: string, missingMessage?: string): Promise<void> {
		const file = this.plugin.app.vault.getAbstractFileByPath(path);
		if (!(file instanceof TFile)) {
			new Notice(missingMessage ?? `File not found: ${path}`);
			return;
		}
		await this.plugin.app.workspace.getLeaf(false).openFile(file);
	}
}
