export const SIDEBAR_PREFERENCES_KEY = "jarvis.sidebar.preferences";

export const defaultSidebarPreferences = Object.freeze({
  organization: "list",
  sorting: "updated",
  filter: "all",
  manualOrder: [],
});

/** @param {unknown} value */
export function normalizeSidebarPreferences(value) {
  if (!value || typeof value !== "object") return { ...defaultSidebarPreferences };
  const prefs = /** @type {Record<string, unknown>} */ (value);
  return {
    organization: prefs.organization === "project" ? "project" : "list",
    sorting: prefs.sorting === "manual" ? "manual" : "updated",
    filter: ["all", "pinned", "archived", "locked"].includes(String(prefs.filter)) ? prefs.filter : "all",
    manualOrder: Array.isArray(prefs.manualOrder) ? prefs.manualOrder.filter((id) => typeof id === "string") : [],
  };
}

/** @param {string | null} saved */
export function restoreSidebarPreferences(saved) {
  if (!saved) return { ...defaultSidebarPreferences };
  try { return normalizeSidebarPreferences(JSON.parse(saved)); } catch { return { ...defaultSidebarPreferences }; }
}

/** Stable sort: timestamp descending, original array order for ties and unknown dates. @param {Array<{id: string, updatedAt?: number}>} conversations @param {"updated"|"manual"} sorting @param {string[]} manualOrder */
export function orderConversations(conversations, sorting, manualOrder) {
  const original = new Map(conversations.map((conversation, index) => [conversation.id, index]));
  const rank = new Map(manualOrder.map((id, index) => [id, index]));
  return [...conversations].sort((a, b) => {
    if (sorting === "manual") {
      const rankA = rank.get(a.id) ?? Number.MAX_SAFE_INTEGER;
      const rankB = rank.get(b.id) ?? Number.MAX_SAFE_INTEGER;
      return rankA - rankB || original.get(a.id) - original.get(b.id);
    }
    const timeA = Number.isFinite(a.updatedAt) ? a.updatedAt : Number.NEGATIVE_INFINITY;
    const timeB = Number.isFinite(b.updatedAt) ? b.updatedAt : Number.NEGATIVE_INFINITY;
    return timeB - timeA || original.get(a.id) - original.get(b.id);
  });
}

/** @param {Array<{title?: string, pinned?: boolean, archived?: boolean, locked?: boolean}>} conversations @param {"all"|"pinned"|"archived"|"locked"} filter @param {string} query */
export function filterConversations(conversations, filter, query) {
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  return conversations.filter((conversation) => {
    const stateMatches = filter === "all"
      || (filter === "pinned" && conversation.pinned === true && conversation.archived !== true)
      || (filter === "archived" && conversation.archived === true)
      || (filter === "locked" && conversation.locked === true);
    return stateMatches && (!needle || (conversation.title ?? "Conversa sem título").toLocaleLowerCase("pt-BR").includes(needle));
  });
}

/** Reorder only ids inside the visible section; other categories keep their relative order. @param {string[]} manualOrder @param {string[]} sectionIds @param {string} conversationId @param {-1|1} direction */
export function moveWithinSection(manualOrder, sectionIds, conversationId, direction) {
  const normalized = [...manualOrder];
  for (const id of sectionIds) if (!normalized.includes(id)) normalized.push(id);
  const visible = normalized.filter((id) => sectionIds.includes(id));
  const from = visible.indexOf(conversationId);
  const to = from + direction;
  if (from < 0 || to < 0 || to >= visible.length) return normalized;
  [visible[from], visible[to]] = [visible[to], visible[from]];
  let index = 0;
  return normalized.map((id) => sectionIds.includes(id) ? visible[index++] : id);
}

/** @param {string[]} manualOrder @param {string[]} sectionIds @param {string} sourceId @param {string} targetId */
export function dropWithinSection(manualOrder, sectionIds, sourceId, targetId) {
  if (sourceId === targetId || !sectionIds.includes(sourceId) || !sectionIds.includes(targetId)) return manualOrder;
  const normalized = [...manualOrder];
  for (const id of sectionIds) if (!normalized.includes(id)) normalized.push(id);
  const visible = normalized.filter((id) => sectionIds.includes(id));
  visible.splice(visible.indexOf(sourceId), 1);
  visible.splice(visible.indexOf(targetId), 0, sourceId);
  let index = 0;
  return normalized.map((id) => sectionIds.includes(id) ? visible[index++] : id);
}
