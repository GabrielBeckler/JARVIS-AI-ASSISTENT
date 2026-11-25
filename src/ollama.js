/** @typedef {{ role: "user" | "assistant", content: string }} OllamaMessage */
/** @typedef {OllamaMessage & { id?: string, model?: string, createdAt?: number, requestId?: string, delivery?: "pending" | "sent" | "failed" }} StoredMessage */
/** @typedef {{ name?: string, model?: string | null }} OllamaModel */

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

/** @param {string} prompt @param {boolean} [hasHistory] */
export function shouldUseFastMode(prompt, hasHistory = false) {
  const text = prompt.trim();
  if (!text || hasHistory || text.length > 120) return false;
  if (/\b(why|por que|por quê|explique|explain|analise|analyze|compare|justifique|justify|demonstre|prove|passo a passo|step by step|código|code|debug|resolva|solve|planeje|plan|resuma|summari[sz]e|detalhe|detail|crie|create|escreva|write|gere|generate)\b/i.test(text)) return false;

  const explicitBrevity = /\b(apenas|somente|só|responda (?:curto|brevemente)|em uma frase|just|only|briefly)\b/i.test(text);
  const directQuestion = /\?$/.test(text) && /^(?:o que|qual|quem|onde|quando|quanto|tem|existe|é|what|which|who|where|when|how much|is there|does)\b/i.test(text);
  const greeting = /^(?:oi|olá|ola|bom dia|boa tarde|boa noite|hi|hello|hey)[!.?]*$/i.test(text);
  return explicitBrevity || directQuestion || greeting;
}
