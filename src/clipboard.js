/** @param {string} text @param {{writeText: (value: string) => Promise<void>} | undefined} [clipboard] @param {Document | undefined} [documentObject] */
export async function copyResponseText(text, clipboard = globalThis.navigator?.clipboard, documentObject = globalThis.document) {
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return;
    } catch (clipboardError) {
      if (!documentObject?.body || typeof documentObject.execCommand !== "function") throw clipboardError;
    }
  }

  if (!documentObject?.body || typeof documentObject.execCommand !== "function") {
    throw new Error("A área de transferência não está disponível nesta janela.");
  }

  const field = documentObject.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.setAttribute("aria-hidden", "true");
  field.style.position = "fixed";
  field.style.left = "-10000px";
  field.style.top = "0";
  documentObject.body.appendChild(field);
  field.select();
  try {
    if (!documentObject.execCommand("copy")) throw new Error("A cópia foi recusada pela janela.");
  } finally {
    field.remove();
  }
}
