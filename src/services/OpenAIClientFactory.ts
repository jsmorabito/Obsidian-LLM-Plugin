import OpenAI from "openai";
import { lmStudio, mistral, ollama } from "utils/constants";

/** The subset of plugin settings needed to build an OpenAI-compatible client. */
export interface OpenAIClientSettings {
	openAIAPIKey: string;
	mistralAPIKey: string;
	ollamaHost: string;
	lmStudioHost: string;
}

/**
 * Build an OpenAI SDK client for any OpenAI-compatible provider (OpenAI,
 * Mistral, Ollama, LM Studio). Shared by ChatContainer and the headless
 * LoopRunner so both talk to the same endpoints with the same keys.
 */
export function createOpenAICompatibleClient(settings: OpenAIClientSettings, modelType: string): OpenAI {
	if (modelType === ollama) {
		return new OpenAI({
			apiKey: "ollama",
			baseURL: `${settings.ollamaHost}/v1`,
			dangerouslyAllowBrowser: true,
			timeout: 30000,
		});
	}
	if (modelType === lmStudio) {
		return new OpenAI({
			apiKey: "lm-studio",
			baseURL: `${settings.lmStudioHost}/v1`,
			dangerouslyAllowBrowser: true,
			timeout: 30000,
		});
	}
	if (modelType === mistral) {
		return new OpenAI({
			apiKey: settings.mistralAPIKey,
			baseURL: "https://api.mistral.ai/v1",
			dangerouslyAllowBrowser: true,
		});
	}
	// openAI
	return new OpenAI({
		apiKey: settings.openAIAPIKey,
		dangerouslyAllowBrowser: true,
	});
}
