export type OllamaMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatMetrics = { firstContentMs: number | null; totalElapsedMs: number | null; ollamaTotalMs: number | null; tokensPerSecond: number | null };
export type StoredMessage = OllamaMessage & { id?: string; model?: string; createdAt?: number; requestId?: string; delivery?: "pending" | "sent" | "failed"; metrics?: ChatMetrics };

type OllamaModel = { name?: string; model?: string | null };

export function isModelInstalled(models: readonly OllamaModel[], requestedModel: string): boolean;
export function toChatContext(messages: readonly StoredMessage[]): OllamaMessage[];
export function limitChatContext(messages: readonly OllamaMessage[], maxChars?: number): OllamaMessage[];
export function shouldUseFastMode(prompt: string, hasHistory?: boolean): boolean;
