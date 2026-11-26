/** @param {number} scrollHeight @param {number} lineHeight @param {number} paddingTop @param {number} paddingBottom */
export function calculateComposerSize(scrollHeight, lineHeight, paddingTop, paddingBottom) {
  const safeLineHeight = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 18;
  const verticalPadding = Math.max(0, paddingTop) + Math.max(0, paddingBottom);
  const minHeight = Math.ceil(safeLineHeight + verticalPadding);
  const maxHeight = Math.ceil(safeLineHeight * 10 + verticalPadding);
  const measuredHeight = Number.isFinite(scrollHeight) ? scrollHeight : minHeight;
  return {
    height: Math.max(minHeight, Math.min(measuredHeight, maxHeight)),
    maxHeight,
    overflowY: measuredHeight > maxHeight + 1 ? "auto" : "hidden",
  };
}
