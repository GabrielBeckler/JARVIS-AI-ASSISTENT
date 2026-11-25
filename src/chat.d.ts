import type { StoredMessage } from "./ollama.js";

export type StoredConversation = { id: string; title: string; updatedAt: number; messages: StoredMessage[] };

export function restoreConversations(saved: string | null, starter: StoredConversation[]): StoredConversation[];
export function updateMessage(
  conversations: StoredConversation[],
  conversationId: string,
  messageId: string,
  changes: Partial<StoredMessage>,
): StoredConversation[];
export function appendAssistantOnce(
  conversations: StoredConversation[],
  conversationId: string,
  requestId: string,
  assistantMessage: StoredMessage,
): StoredConversation[];
export function isCurrentRequest(activeRequests: Map<string, string>, conversationId: string, requestId: string): boolean;
