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

/** @param {string} conversationId @param {string} requestId @param {string} model */
export function createRequestContext(conversationId, requestId, model) {
  return Object.freeze({ conversationId, requestId, model });
}

/** @param {{scrollTop: number, scrollHeight: number, clientHeight: number}} element @param {number} [threshold] */
export function captureScrollPosition(element, threshold = 96) {
  return {
    scrollTop: element.scrollTop,
    followBottom: element.scrollHeight - element.clientHeight - element.scrollTop <= threshold,
  };
}

/** @param {{scrollHeight: number, clientHeight: number}} element @param {{scrollTop: number, followBottom: boolean} | undefined} saved */
export function restoreScrollTop(element, saved) {
  if (!saved || saved.followBottom) return Math.max(0, element.scrollHeight - element.clientHeight);
  return Math.max(0, Math.min(saved.scrollTop, element.scrollHeight - element.clientHeight));
}

/** @param {Readonly<Record<string, string>>} drafts @param {string} conversationId */
export function getConversationDraft(drafts, conversationId) {
  return drafts[conversationId] ?? "";
}

/** @param {Readonly<Record<string, string>>} drafts @param {string} conversationId @param {string} value */
export function setConversationDraft(drafts, conversationId, value) {
  const next = { ...drafts };
  if (value) next[conversationId] = value;
  else delete next[conversationId];
  return next;
}

/** @param {Array<{id: string, title?: string, updatedAt?: number, messages: ChatMessage[]}>} conversations @param {string} conversationId @param {string} title @param {number} updatedAt */
export function renameConversationTitle(conversations, conversationId, title, updatedAt) {
  return conversations.map((conversation) => conversation.id === conversationId
    ? { ...conversation, title, updatedAt }
    : conversation);
}

/** @param {Array<{id: string, pinned?: boolean, archived?: boolean}>} conversations @param {string} conversationId @param {{pinned?: boolean, archived?: boolean}} changes */
export function updateConversationFlags(conversations, conversationId, changes) {
  return conversations.map((conversation) => conversation.id === conversationId ? { ...conversation, ...changes } : conversation);
}

/** @param {Array<{id: string}>} conversations @param {string} conversationId */
export function removeConversation(conversations, conversationId) {
  return conversations.filter((conversation) => conversation.id !== conversationId);
}

/** Export original text with role labels; Markdown formatting remains intact. @param {{title?: string, messages: Array<{role: string, content: string}>}} conversation */
export function exportConversationMarkdown(conversation) {
  const title = conversation.title?.trim() || "Conversa sem título";
  const messages = conversation.messages.filter((message) => message.role === "user" || message.role === "assistant");
  return `# ${title}\n\n${messages.map((message) => `## ${message.role === "user" ? "Você" : "JARVIS"}\n\n${message.content}`).join("\n\n---\n\n")}\n`;
}