/** @typedef {"system" | "ai" | "project"} DashboardTab */

/** @type {DashboardTab[]} */
export const dashboardTabs = ["system", "ai", "project"];

/** @param {DashboardTab} current @param {string} key @returns {DashboardTab | null} */
export function nextDashboardTab(current, key) {
  const index = dashboardTabs.indexOf(current);
  if (index < 0) return null;
  if (key === "ArrowRight") return dashboardTabs[(index + 1) % dashboardTabs.length];
  if (key === "ArrowLeft") return dashboardTabs[(index + dashboardTabs.length - 1) % dashboardTabs.length];
  if (key === "Home") return dashboardTabs[0];
  if (key === "End") return dashboardTabs[dashboardTabs.length - 1];
  return null;
}
