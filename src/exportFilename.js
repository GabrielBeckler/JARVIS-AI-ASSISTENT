/** @param {string | null | undefined} title */
export function sanitizeExportFilename(title) {
  return (title || "conversa").replace(/[\\/:*?"<>|]/gu, "-").slice(0, 100);
}
