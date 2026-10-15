import { FuzzySuggestModal } from "obsidian";
import type LLMPlugin from "main";
import { LoopDefinition } from "./LoopManager";

/** "Run loop…" command picker. Lists every discovered loop, enabled or not. */
export class LoopPickerModal extends FuzzySuggestModal<LoopDefinition> {
	constructor(private plugin: LLMPlugin) {
		super(plugin.app);
		this.setPlaceholder("Run loop…");
	}

	getItems(): LoopDefinition[] {
		return this.plugin.loopManager.getLoops();
	}

	getItemText(loop: LoopDefinition): string {
		return loop.description ? `${loop.name} — ${loop.description}` : loop.name;
	}

	onChooseItem(loop: LoopDefinition): void {
		this.plugin.loopRunner.runNow(loop.id);
	}
}
