export function splitTitleGraphemes(value: string): string[];
export function countTitleGraphemes(value: string): number;
export function createConversationTitle(firstMessage: string): string;
export function resolveConversationTitle(
  existingTitle: string | null | undefined,
  messages: readonly { role: string; content: string }[],
  newMessage: string,
): string;
export function validateConversationTitle(input: string): { value: string; count: number; valid: boolean };
