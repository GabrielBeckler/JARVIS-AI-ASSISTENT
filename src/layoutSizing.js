export const LAYOUT_STORAGE_KEY = "jarvis.layout.widths";
export const SIDEBAR_MIN_WIDTH = 190;
export const SIDEBAR_MAX_WIDTH = 340;
export const DASHBOARD_MIN_WIDTH = 240;
export const DASHBOARD_MAX_WIDTH = 420;
export const CHAT_MIN_WIDTH = 420;
export const DIVIDER_WIDTH = 7;

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
  const availableForRails = Math.max(0, containerWidth - CHAT_MIN_WIDTH - DIVIDER_WIDTH * 2);
  const sideMax = Math.max(0, Math.min(SIDEBAR_MAX_WIDTH, availableForRails - DASHBOARD_MIN_WIDTH));
  const sidebarWidth = Math.min(Math.max(widths.sidebarWidth, Math.min(SIDEBAR_MIN_WIDTH, sideMax)), sideMax);
  const dashboardMax = Math.max(0, Math.min(DASHBOARD_MAX_WIDTH, availableForRails - sidebarWidth));
  const dashboardWidth = Math.min(Math.max(widths.dashboardWidth, Math.min(DASHBOARD_MIN_WIDTH, dashboardMax)), dashboardMax);
  return { sidebarWidth: Math.round(sidebarWidth), dashboardWidth: Math.round(dashboardWidth) };
}

/** @param {{sidebarWidth: number, dashboardWidth: number}} widths @param {"sidebar"|"dashboard"} area @param {number} delta @param {number} containerWidth */
export function resizeLayoutArea(widths, area, delta, containerWidth) {
  return clampLayoutWidths({
    ...widths,
    [area === "sidebar" ? "sidebarWidth" : "dashboardWidth"]: widths[area === "sidebar" ? "sidebarWidth" : "dashboardWidth"] + delta,
  }, containerWidth);
}

/** @param {{sidebarWidth: number, dashboardWidth: number}} widths @param {number} containerWidth */
export function getLayoutLimits(widths, containerWidth) {
  const availableForRails = Math.max(0, containerWidth - CHAT_MIN_WIDTH - DIVIDER_WIDTH * 2);
  const sidebarMax = Math.max(0, Math.min(SIDEBAR_MAX_WIDTH, availableForRails - DASHBOARD_MIN_WIDTH));
  const sidebarWidth = Math.min(Math.max(widths.sidebarWidth, 0), sidebarMax);
  const dashboardMax = Math.max(0, Math.min(DASHBOARD_MAX_WIDTH, availableForRails - sidebarWidth));
  return {
    sidebar: { min: Math.min(SIDEBAR_MIN_WIDTH, sidebarMax), max: sidebarMax },
    dashboard: { min: Math.min(DASHBOARD_MIN_WIDTH, dashboardMax), max: dashboardMax },
  };
}
