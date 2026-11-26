/** @param {{key: string, ctrlKey: boolean, altKey: boolean, metaKey: boolean, shiftKey: boolean, repeat: boolean, defaultPrevented: boolean, isComposing: boolean}} event @param {boolean} [overlayOpen] */
export function getConversationShortcut(event, overlayOpen = false) {
  if (overlayOpen || event.defaultPrevented || event.repeat || event.isComposing) return null;
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  const key = event.key.toLocaleLowerCase("en-US");
  if (key === "k") return "new_conversation";
  if (key === "f") return "focus_search";
  return null;
}
