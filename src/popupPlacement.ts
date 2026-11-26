export function placePopup(anchor: HTMLElement, popup: HTMLElement, alignment: "left" | "right") {
  const edge = 8;
  const gap = 4;
  const rect = anchor.getBoundingClientRect();
  const below = window.innerHeight - rect.bottom - edge - gap;
  const above = rect.top - edge - gap;
  const openAbove = popup.scrollHeight > below && above > below;
  popup.style.maxHeight = `${Math.max(0, openAbove ? above : below)}px`;
  popup.style.top = `${openAbove ? rect.top - gap - popup.offsetHeight : rect.bottom + gap}px`;
  const left = alignment === "right" ? rect.right - popup.offsetWidth : rect.left;
  popup.style.left = `${Math.max(edge, Math.min(left, window.innerWidth - edge - popup.offsetWidth))}px`;
}
