/**
 * LoopScheduler — fires `on-startup` and `interval` triggers.
 *
 *  - Startup: STARTUP_DELAY_MS after layout-ready, run every enabled
 *    `on-startup` loop once, and every enabled `interval` loop that is overdue
 *    (or has never run) once — a single catch-up run, not one per missed tick.
 *  - Interval: a once-a-minute tick (registered via plugin.registerInterval so
 *    it is cleared on unload) queues overdue interval loops.
 *
 * `lastRunAt` lives in `loopSettings` (data.json), so schedules survive
 * restarts. All runs go through LoopRunner.enqueue(), which skips loops that
 * are already running or queued.
 */

import type LLMPlugin from "main";
import { logger } from "../utils/logger";
import { LoopDefinition } from "./LoopManager";

const STARTUP_DELAY_MS = 10_000;
const TICK_MS = 60_000;

export class LoopScheduler {
	private started = false;

	constructor(private plugin: LLMPlugin) {}

	/** Call once from onLayoutReady, after LoopManager has loaded. */
	start(): void {
		if (this.started) return;
		this.started = true;

		const startupTimer = window.setTimeout(() => this.runStartupTriggers(), STARTUP_DELAY_MS);
		this.plugin.register(() => window.clearTimeout(startupTimer));
		this.plugin.registerInterval(window.setInterval(() => this.tick(), TICK_MS));
	}

	private isActive(): boolean {
		return !!this.plugin.settings.featureSettings?.loops && !!this.plugin.settings.rootVaultFolder;
	}

	private runStartupTriggers(): void {
		if (!this.isActive()) return;
		for (const loop of this.plugin.loopManager.getLoops()) {
			if (!loop.enabled) continue;
			if (loop.trigger === "on-startup") {
				this.plugin.loopRunner.enqueue(loop.id, "on-startup");
			} else if (loop.trigger === "interval" && this.isOverdue(loop)) {
				logger.log(`[LoopScheduler] Catching up overdue loop "${loop.id}".`);
				this.plugin.loopRunner.enqueue(loop.id, "interval");
			}
		}
	}

	private tick(): void {
		if (!this.isActive()) return;
		for (const loop of this.plugin.loopManager.getLoops()) {
			if (loop.enabled && loop.trigger === "interval" && this.isOverdue(loop)) {
				this.plugin.loopRunner.enqueue(loop.id, "interval");
			}
		}
	}

	/** Due when it has never run or its interval has elapsed since the last run started. */
	isOverdue(loop: LoopDefinition, now = Date.now()): boolean {
		if (loop.intervalMs === null) return false;
		const last = this.plugin.loopRunner.getState(loop.id)?.lastRunAt ?? 0;
		return now - last >= loop.intervalMs;
	}

	/** Epoch ms of the next scheduled run, or null for non-interval loops. */
	nextRunAt(loop: LoopDefinition): number | null {
		if (loop.trigger !== "interval" || loop.intervalMs === null) return null;
		const last = this.plugin.loopRunner.getState(loop.id)?.lastRunAt ?? 0;
		return last + loop.intervalMs;
	}
}
