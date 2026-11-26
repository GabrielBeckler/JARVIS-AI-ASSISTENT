import type { StoredMessage } from "./ollama.js";

export type StoredConversation = { id: string; title?: string; updatedAt?: number; messages: StoredMessage[] };

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
export function createRequestContext(conversationId: string, requestId: string, model: string): Readonly<{ conversationId: string; requestId: string; model: string }>;
export function captureScrollPosition(element: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold?: number): { scrollTop: number; followBottom: boolean };
export function restoreScrollTop(element: { scrollHeight: number; clientHeight: number }, saved?: { scrollTop: number; followBottom: boolean }): number;
export function getConversationDraft(drafts: Readonly<Record<string, string>>, conversationId: string): string;
export function setConversationDraft(drafts: Readonly<Record<string, string>>, conversationId: string, value: string): Record<string, string>;
export function renameConversationTitle(conversations: StoredConversation[], conversationId: string, title: string, updatedAt: number): StoredConversation[];
