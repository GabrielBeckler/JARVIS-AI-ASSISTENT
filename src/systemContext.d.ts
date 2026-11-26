import type { SystemSnapshot } from "./systemMonitor";

export function isSystemQuestion(prompt: string, history?: readonly { role: string; content: string }[]): boolean;
export function createSystemContextPrompt(
  prompt: string,
  snapshot: SystemSnapshot | null,
  options?: { collectionFailed?: boolean; now?: number; staleAfterMs?: number },
): string;
