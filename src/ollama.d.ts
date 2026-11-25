export type OllamaMessage = { role: "user" | "assistant"; content: string };
export type StoredMessage = OllamaMessage & { delivery?: "pending" | "failed" };

type OllamaModel = { name?: string; model?: string };

export function isModelInstalled(models: readonly OllamaModel[], requestedModel: string): boolean;
export function toChatContext(messages: readonly StoredMessage[]): OllamaMessage[];
