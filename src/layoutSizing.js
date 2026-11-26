export const LAYOUT_STORAGE_KEY = "jarvis.layout.widths";
export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 340;
export const DASHBOARD_MIN_WIDTH = 240;
export const DASHBOARD_MAX_WIDTH = 420;
export const CHAT_MIN_WIDTH = 420;
export const DIVIDER_WIDTH = 7;
const THREE_PANEL_MIN_WIDTH = SIDEBAR_MIN_WIDTH + DASHBOARD_MIN_WIDTH + CHAT_MIN_WIDTH + DIVIDER_WIDTH * 2;
const clamp = (value, min, max) => Math.min(Math.max(Math.round(value), min), max);

export const defaultLayoutWidths = Object.freeze({ sidebarWidth: 238, dashboardWidth: 304 });

/** @param {string | null} saved */
export function restoreLayoutWidths(saved) {
  if (!saved) return { ...defaultLayoutWidths };
  try {
    const value = JSON.parse(saved);
    return {
      sidebarWidth: Number.isFinite(value?.sidebarWidth) ? value.sidebarWidth : defaultLayoutWidths.sidebarWidth,
      dashboardWidth: Number.isFinite(value?.dashboardWidth) ? value.dashboardWidth : defaultLayoutWidths.dashboardWidth,
    };
  } catch {
    return { ...defaultLayoutWidths };
  }
}

/** @param {{sidebarWidth: number, dashboardWidth: number}} widths @param {number} containerWidth */
export function clampLayoutWidths(widths, containerWidth) {
  const room = Math.floor(containerWidth) - CHAT_MIN_WIDTH - DIVIDER_WIDTH * 2;
  const sidebarMax = containerWidth < THREE_PANEL_MIN_WIDTH
    ? Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, room + DIVIDER_WIDTH))
    : Math.min(SIDEBAR_MAX_WIDTH, room - DASHBOARD_MIN_WIDTH);
  const sidebarWidth = clamp(widths.sidebarWidth, SIDEBAR_MIN_WIDTH, sidebarMax);
  const dashboardWidth = clamp(widths.dashboardWidth, DASHBOARD_MIN_WIDTH, Math.min(DASHBOARD_MAX_WIDTH, Math.max(DASHBOARD_MIN_WIDTH, room - sidebarWidth)));
  return { sidebarWidth, dashboardWidth };
}

/** @param {{sidebarWidth: number, dashboardWidth: number}} widths @param {"sidebar"|"dashboard"} area @param {number} delta @param {number} containerWidth */
export function resizeLayoutArea(widths, area, delta, containerWidth) {
  const key = area === "sidebar" ? "sidebarWidth" : "dashboardWidth";
  const { min, max } = getLayoutLimits(widths, containerWidth)[area];
  return { ...widths, [key]: clamp(widths[key] + delta, min, max) };
}

/** @param {{sidebarWidth: number, dashboardWidth: number}} widths @param {number} containerWidth */
export function getLayoutLimits(widths, containerWidth) {
  const room = Math.floor(containerWidth) - CHAT_MIN_WIDTH - DIVIDER_WIDTH * 2;
  const sidebarRoom = containerWidth < THREE_PANEL_MIN_WIDTH ? room + DIVIDER_WIDTH : room - widths.dashboardWidth;
  return {
    sidebar: { min: SIDEBAR_MIN_WIDTH, max: clamp(sidebarRoom, SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH) },
    dashboard: { min: DASHBOARD_MIN_WIDTH, max: clamp(room - widths.sidebarWidth, DASHBOARD_MIN_WIDTH, DASHBOARD_MAX_WIDTH) },
  };
}
