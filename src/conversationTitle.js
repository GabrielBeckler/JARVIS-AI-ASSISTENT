const TITLE_LIMIT = 120;

/** @param {string} value */
export function splitTitleGraphemes(value) {
  if (typeof Intl.Segmenter === "function") {
    const segmenter = new Intl.Segmenter("pt-BR", { granularity: "grapheme" });
    return Array.from(segmenter.segment(value), (entry) => entry.segment);
  }
  return Array.from(value);
}

/** @param {string} value */
export function countTitleGraphemes(value) {
  return splitTitleGraphemes(value).length;
}

/** Generate a one-line title from the first user message, with an ellipsis inside the 120-grapheme limit. @param {string} firstMessage */
export function createConversationTitle(firstMessage) {
  const oneLine = firstMessage.trim().replace(/\s+/gu, " ");
  const graphemes = splitTitleGraphemes(oneLine);
  if (graphemes.length <= TITLE_LIMIT) return oneLine;
  return `${graphemes.slice(0, TITLE_LIMIT - 1).join("").trimEnd()}…`;
}

/** Keep an existing title verbatim; otherwise derive it from the earliest user message. @param {string | null | undefined} existingTitle @param {readonly {role: string, content: string}[]} messages @param {string} newMessage */
export function resolveConversationTitle(existingTitle, messages, newMessage) {
  if (typeof existingTitle === "string" && existingTitle.trim()) return existingTitle;
  const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? newMessage;
  return createConversationTitle(firstUserMessage);
}

/** @param {string} input */
export function validateConversationTitle(input) {
  const value = input.trim();
  const count = countTitleGraphemes(value);
  return { value, count, valid: count > 0 && count <= TITLE_LIMIT };
}
