export type OllamaMessage = { role: "user" | "assistant"; content: string };
export type StoredMessage = OllamaMessage & { delivery?: "pending" | "failed" };

type OllamaModel = { name?: string; model?: string };

export function isModelInstalled(models: readonly OllamaModel[], requestedModel: string): boolean;
export function toChatContext(messages: readonly StoredMessage[]): OllamaMessage[];
export function shouldUseFastMode(prompt: string, hasHistory?: boolean): boolean;

export type OllamaChatChunk = { message?: { content?: string; thinking?: string }; error?: string; done?: boolean };
export function readOllamaChatStream(
  body: ReadableStream<Uint8Array>,
  onContent: (content: string) => void,
): Promise<{ content: string; final: OllamaChatChunk }>;
