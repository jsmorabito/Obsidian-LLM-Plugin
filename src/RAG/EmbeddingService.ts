import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

export type EmbeddingProvider = "openai" | "gemini" | "ollama";

export interface EmbeddingConfig {
	provider: EmbeddingProvider;
	model: string;
	/** OpenAI API key (used when provider === "openai") */
	openAIKey?: string;
	/** Gemini API key (used when provider === "gemini") */
	geminiKey?: string;
	/** Ollama host URL, e.g. "http://localhost:11434" (used when provider === "ollama") */
	ollamaHost?: string;
}

export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
	openai: "text-embedding-3-small",
	gemini: "text-embedding-004",
	ollama: "nomic-embed-text",
};

export class EmbeddingService {
	constructor(private config: EmbeddingConfig) {}

	async embed(text: string): Promise<number[]> {
		const { provider, model } = this.config;

		switch (provider) {
			case "openai":
				return this.embedOpenAI(text, model);
			case "gemini":
				return this.embedGemini(text, model);
			case "ollama":
				return this.embedOllama(text, model);
			default:
				throw new Error(`[RAG] Unknown embedding provider: ${provider}`);
		}
	}

	/** Embed a batch of texts, returning vectors in the same order. */
	async embedBatch(texts: string[]): Promise<number[][]> {
		// OpenAI supports true batching; others fall back to sequential
		if (this.config.provider === "openai") {
			return this.embedBatchOpenAI(texts, this.config.model);
		}
		const results: number[][] = [];
		for (const text of texts) {
			results.push(await this.embed(text));
		}
		return results;
	}

	// ── OpenAI ───────────────────────────────────────────────────────────────

	private async embedOpenAI(text: string, model: string): Promise<number[]> {
		const [result] = await this.embedBatchOpenAI([text], model);
		return result;
	}

	private async embedBatchOpenAI(texts: string[], model: string): Promise<number[][]> {
		const key = this.config.openAIKey;
		if (!key) throw new Error("[RAG] OpenAI API key not set");
		const client = new OpenAI({ apiKey: key, dangerouslyAllowBrowser: true });
		const response = await client.embeddings.create({ model, input: texts });
		// Response data is sorted by index
		return response.data
			.sort((a, b) => a.index - b.index)
			.map(item => item.embedding);
	}

	// ── Gemini ───────────────────────────────────────────────────────────────

	private async embedGemini(text: string, model: string): Promise<number[]> {
		const key = this.config.geminiKey;
		if (!key) throw new Error("[RAG] Gemini API key not set");
		const client = new GoogleGenAI({ apiKey: key });
		const response = await client.models.embedContent({
			model,
			contents: text,
		});
		const values = response.embeddings?.[0]?.values;
		if (!values) throw new Error("[RAG] Gemini returned no embedding");
		return values;
	}

	// ── Ollama ───────────────────────────────────────────────────────────────

	private async embedOllama(text: string, model: string): Promise<number[]> {
		const host = this.config.ollamaHost ?? "http://localhost:11434";
		// Ollama supports the OpenAI-compatible /v1/embeddings endpoint
		const client = new OpenAI({
			apiKey: "ollama",
			baseURL: `${host}/v1`,
			dangerouslyAllowBrowser: true,
		});
		const response = await client.embeddings.create({ model, input: text });
		const embedding = response.data[0]?.embedding;
		if (!embedding) throw new Error("[RAG] Ollama returned no embedding");
		return embedding;
	}
}
