/** @typedef {{ role: "user" | "assistant", content: string }} OllamaMessage */
/** @typedef {OllamaMessage & { delivery?: "pending" | "failed" }} StoredMessage */
/** @typedef {{ name?: string, model?: string }} OllamaModel */

/** @param {readonly OllamaModel[]} models @param {string} requestedModel */
export function isModelInstalled(models, requestedModel) {
  const requested = requestedModel.trim().toLocaleLowerCase();
  if (!requested) return false;

  return models.some((model) => [model.name, model.model]
    .some((name) => name?.trim().toLocaleLowerCase() === requested));
}

/** @param {readonly StoredMessage[]} messages @returns {OllamaMessage[]} */
export function toChatContext(messages) {
  return messages
    .filter((message) => message.delivery !== "failed" && message.delivery !== "pending")
    .map(({ role, content }) => ({ role, content }));
}
