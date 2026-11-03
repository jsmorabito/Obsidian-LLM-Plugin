import { browser, expect } from "@wdio/globals";
import "wdio-obsidian-service";
import { PLUGIN_ID } from "./helpers.js";

/**
 * Loops: discovery of a vault LOOP.md and a manual run via the "Run loop…"
 * command palette picker.
 *
 * No API keys exist in the staged data.json, so the run can't reach a model —
 * it must still end cleanly with status "error", write a run log, and append
 * to STATE.md. That exercises the full headless pipeline except the model call.
 */

const LOOP_ID = "e2e-loop";
const LOOP_DIR = `AI/Loops/${LOOP_ID}`;
const LOOP_MD = `---
name: E2E loop
description: Loop used by the E2E suite
enabled: true
trigger: manual
permission: staging
max_tool_calls: 3
max_tokens_per_run: 1000
---
List the notes in Notes/ and summarise them.
`;

describe("loops", function () {
	before(async function () {
		await browser.executeObsidian(async ({ app }, pluginId, dir, body) => {
			const plugin = (app as any).plugins.plugins[pluginId];
			plugin.settings.featureSettings.loops = true;
			await plugin.saveSettings();
			const adapter = app.vault.adapter;
			for (const p of ["AI", "AI/Loops", dir]) {
				if (!(await adapter.exists(p))) await adapter.mkdir(p);
			}
			await adapter.write(`${dir}/LOOP.md`, body);
			await plugin.reinitLoopManager();
		}, PLUGIN_ID, LOOP_DIR, LOOP_MD);
	});

	it("discovers LOOP.md and parses its frontmatter", async function () {
		const loop = await browser.executeObsidian(({ app }, pluginId, id) => {
			const l = (app as any).plugins.plugins[pluginId].loopManager.getLoop(id);
			return l && { name: l.name, trigger: l.trigger, permission: l.permission, maxToolCalls: l.maxToolCalls, worker: l.worker };
		}, PLUGIN_ID, LOOP_ID);
		expect(loop).toEqual({
			name: "E2E loop",
			trigger: "manual",
			permission: "staging",
			maxToolCalls: 3,
			worker: "obsidian-agent",
		});
	});

	it("confines staging writes to the loop's drafts folder", async function () {
		const verdicts = await browser.executeObsidian(({ app }, pluginId, dir) => {
			const Runner = (app as any).plugins.plugins[pluginId].loopRunner.constructor;
			const guard = Runner.makeToolGuard(`${dir}/drafts`);
			return {
				inside: guard("obsidian_create_note", { path: `${dir}/drafts/a.md`, content: "" }),
				outside: guard("obsidian_create_note", { path: "Notes/a.md", content: "" }),
				traversal: guard("obsidian_modify_note", { path: `${dir}/drafts/../LOOP.md`, content: "" }),
				read: guard("obsidian_read_note", { path: "Notes/a.md" }),
				danger: guard("run_shell_command", { command: "ls" }),
			};
		}, PLUGIN_ID, LOOP_DIR);
		expect(verdicts.inside).toBeNull();
		expect(verdicts.read).toBeNull();
		expect(verdicts.outside).not.toBeNull();
		expect(verdicts.traversal).not.toBeNull();
		expect(verdicts.danger).not.toBeNull();
	});

	it("runs a loop by hand from the command palette and records the run", async function () {
		await browser.executeObsidianCommand(`${PLUGIN_ID}:run-loop`);
		const input = await browser.$(".prompt-input");
		await input.waitForDisplayed({ timeout: 5000 });
		await input.setValue("E2E loop");
		await browser.keys("Enter");

		await browser.waitUntil(
			async () =>
				browser.executeObsidian(({ app }, pluginId, id) => {
					const s = (app as any).plugins.plugins[pluginId].settings.loopSettings.loops[id];
					return !!s && s.runCount >= 1 && !(app as any).plugins.plugins[pluginId].loopRunner.isRunning(id);
				}, PLUGIN_ID, LOOP_ID),
			{ timeout: 20000, timeoutMsg: "expected the manual loop run to finish" }
		);

		const outcome = await browser.executeObsidian(async ({ app }, pluginId, id, dir) => {
			const plugin = (app as any).plugins.plugins[pluginId];
			const adapter = app.vault.adapter;
			const runs = await adapter.list(`${dir}/runs`);
			const log = runs.files.length ? await adapter.read(runs.files[0]) : "";
			const state = await adapter.read(`${dir}/STATE.md`);
			return {
				status: plugin.settings.loopSettings.loops[id].lastStatus,
				runLogs: runs.files.length,
				logHasStatus: log.includes("status: error"),
				stateHasHistory: state.includes("## Run history") && state.includes("· error ·"),
			};
		}, PLUGIN_ID, LOOP_ID, LOOP_DIR);

		expect(outcome.status).toBe("error");
		expect(outcome.runLogs).toBe(1);
		expect(outcome.logHasStatus).toBe(true);
		expect(outcome.stateHasHistory).toBe(true);
	});

	it("keeps verifier feedback, user STATE.md text, and every run log across an error run", async function () {
		const outcome = await browser.executeObsidian(async ({ app }, pluginId, id, dir) => {
			const plugin = (app as any).plugins.plugins[pluginId];
			const adapter = app.vault.adapter;
			// Simulate an earlier verifier FAIL and some hand-written STATE.md notes.
			plugin.settings.loopSettings.loops[id].lastVerdict = "FAIL";
			plugin.settings.loopSettings.loops[id].lastFailReasons = ["Missing priority column"];
			const state = await adapter.read(`${dir}/STATE.md`);
			await adapter.write(`${dir}/STATE.md`, state + "\nUser note inside history.\n\n## Notes\nKeep me.\n");

			// Run again immediately — likely the same second as the first run,
			// which must still produce a separate log file.
			const loop = plugin.loopManager.getLoop(id);
			await plugin.loopRunner.runOnce(loop, "manual");

			const after = await adapter.read(`${dir}/STATE.md`);
			const runs = await adapter.list(`${dir}/runs`);
			return {
				failReasons: plugin.settings.loopSettings.loops[id].lastFailReasons,
				running: plugin.loopRunner.isRunning(id),
				runLogs: runs.files.length,
				historyEntries: after.split("\n").filter((l: string) => /^- \d{4}-\d{2}-\d{2}T/.test(l)).length,
				keptUserNote: after.includes("User note inside history."),
				keptNotesSection: after.includes("## Notes\nKeep me."),
			};
		}, PLUGIN_ID, LOOP_ID, LOOP_DIR);

		expect(outcome.failReasons).toEqual(["Missing priority column"]);
		expect(outcome.running).toBe(false);
		expect(outcome.runLogs).toBe(2);
		expect(outcome.historyEntries).toBe(2);
		expect(outcome.keptUserNote).toBe(true);
		expect(outcome.keptNotesSection).toBe(true);
	});

	it("keeps '#' inside quoted values and toggles enabled on an empty frontmatter", async function () {
		const outcome = await browser.executeObsidian(async ({ app }, pluginId) => {
			const plugin = (app as any).plugins.plugins[pluginId];
			const Manager = plugin.loopManager.constructor;
			const parsed = Manager.parseLoopFile(
				'---\nname: "Sprint #4 review"\ndescription: plain # a comment\n---\nBody\n',
				"AI/Loops/q/LOOP.md",
				"AI/Loops",
			);

			const dir = "AI/Loops/empty-fm";
			if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
			await app.vault.adapter.write(`${dir}/LOOP.md`, "---\n\n---\nDo things.\n");
			await plugin.loopManager.loadLoopByPath(`${dir}/LOOP.md`);
			await plugin.loopManager.setEnabled("empty-fm", false);
			const rewritten = await app.vault.adapter.read(`${dir}/LOOP.md`);
			return { name: parsed.name, description: parsed.description, rewritten };
		}, PLUGIN_ID);

		expect(outcome.name).toBe("Sprint #4 review");
		expect(outcome.description).toBe("plain");
		expect(outcome.rewritten).toBe("---\nenabled: false\n---\nDo things.\n");
	});
});
