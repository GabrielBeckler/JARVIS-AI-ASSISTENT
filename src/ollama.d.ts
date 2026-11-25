export type OllamaMessage = { role: "user" | "assistant"; content: string };
export type StoredMessage = OllamaMessage & { id?: string; model?: string; createdAt?: number; requestId?: string; delivery?: "pending" | "sent" | "failed" };

type OllamaModel = { name?: string; model?: string | null };

export function isModelInstalled(models: readonly OllamaModel[], requestedModel: string): boolean;
export function toChatContext(messages: readonly StoredMessage[]): OllamaMessage[];
export function shouldUseFastMode(prompt: string, hasHistory?: boolean): boolean;
