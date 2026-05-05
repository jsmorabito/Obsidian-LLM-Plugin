import { App } from "obsidian";

export interface VectorChunk {
	text: string;
	vector: number[];
}

export interface VectorEntry {
	filePath: string;
	mtime: number;
	chunks: VectorChunk[];
}

interface IndexFile {
	version: number;
	entries: VectorEntry[];
}

const INDEX_VERSION = 1;
const INDEX_PATH = ".obsidian/plugins/Obsidian-LLM-Plugin/rag-index.json";

export class VectorStore {
	private entries: Map<string, VectorEntry> = new Map();
	private dirty = false;

	constructor(private app: App) {}

	// ── Persistence ──────────────────────────────────────────────────────────

	async load(): Promise<void> {
		try {
			const raw = await this.app.vault.adapter.read(INDEX_PATH);
			const parsed: IndexFile = JSON.parse(raw);
			if (parsed.version !== INDEX_VERSION) {
				console.warn("[RAG] Index version mismatch — rebuilding");
				this.entries.clear();
				return;
			}
			this.entries.clear();
			for (const entry of parsed.entries) {
				this.entries.set(entry.filePath, entry);
			}
		} catch {
			// File doesn't exist yet — start fresh
			this.entries.clear();
		}
	}

	async save(): Promise<void> {
		if (!this.dirty) return;
		const data: IndexFile = {
			version: INDEX_VERSION,
			entries: Array.from(this.entries.values()),
		};
		await this.app.vault.adapter.write(INDEX_PATH, JSON.stringify(data));
		this.dirty = false;
	}

	// ── Mutation ──────────────────────────────────────────────────────────────

	upsert(filePath: string, mtime: number, chunks: VectorChunk[]): void {
		this.entries.set(filePath, { filePath, mtime, chunks });
		this.dirty = true;
	}

	remove(filePath: string): void {
		if (this.entries.has(filePath)) {
			this.entries.delete(filePath);
			this.dirty = true;
		}
	}

	/** Returns the stored mtime for a file, or -1 if not indexed. */
	getMtime(filePath: string): number {
		return this.entries.get(filePath)?.mtime ?? -1;
	}

	get size(): number {
		return this.entries.size;
	}

	// ── Search ────────────────────────────────────────────────────────────────

	search(queryVector: number[], topK: number): Array<{ filePath: string; text: string; score: number }> {
		const results: Array<{ filePath: string; text: string; score: number }> = [];

		for (const entry of this.entries.values()) {
			for (const chunk of entry.chunks) {
				const score = cosineSimilarity(queryVector, chunk.vector);
				results.push({ filePath: entry.filePath, text: chunk.text, score });
			}
		}

		results.sort((a, b) => b.score - a.score);
		return results.slice(0, topK);
	}
}

// ── Utility ───────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
	if (a.length !== b.length || a.length === 0) return 0;
	let dot = 0, normA = 0, normB = 0;
	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}
	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	return denom === 0 ? 0 : dot / denom;
}
