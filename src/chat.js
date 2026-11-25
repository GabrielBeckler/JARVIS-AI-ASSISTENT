/** @typedef {{ id?: string, role: "system" | "user" | "assistant", content: string, model?: string, createdAt?: number, requestId?: string, delivery?: "pending" | "sent" | "failed", metrics?: {firstContentMs: number|null, totalElapsedMs: number|null, ollamaTotalMs: number|null, tokensPerSecond: number|null} }} ChatMessage */

/** @param {string | null} saved @param {Array<{id: string, title: string, updatedAt: number, messages: ChatMessage[]}>} starter */
export function restoreConversations(saved, starter) {
  if (!saved) return starter;
  try {
    const parsed = JSON.parse(saved);
    if (!Array.isArray(parsed)) return starter;
    return parsed.filter((conversation) => conversation && typeof conversation.id === "string")
      .map((conversation) => ({
        ...conversation,
        messages: Array.isArray(conversation.messages) ? conversation.messages.map((message, index) => ({
          ...message,
          id: typeof message.id === "string" ? message.id : `${conversation.id}-legacy-${index}`,
          delivery: message.delivery === "pending" ? "failed" : message.delivery,
        })) : [],
      }));
  } catch {
    return starter;
  }
}

/** @param {ChatMessage[]} messages @param {string} conversationId @param {string} messageId @param {Partial<ChatMessage>} changes */
export function updateMessage(messages, conversationId, messageId, changes) {
  return messages.map((conversation) => conversation.id === conversationId
    ? { ...conversation, messages: conversation.messages.map((message) => message.id === messageId ? { ...message, ...changes } : message) }
    : conversation);
}

/** @param {Array<{id: string, messages: ChatMessage[]}>} conversations @param {string} conversationId @param {string} requestId @param {ChatMessage} assistantMessage */
export function appendAssistantOnce(conversations, conversationId, requestId, assistantMessage) {
  return conversations.map((conversation) => {
    if (conversation.id !== conversationId || conversation.messages.some((message) => message.requestId === requestId && message.role === "assistant")) return conversation;
    return { ...conversation, messages: [...conversation.messages, { ...assistantMessage, requestId }] };
  });
}

/** @param {Map<string, string>} activeRequests @param {string} conversationId @param {string} requestId */
export function isCurrentRequest(activeRequests, conversationId, requestId) {
  return activeRequests.get(conversationId) === requestId;
}
