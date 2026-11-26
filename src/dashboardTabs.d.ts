export type DashboardTab = "system" | "ai" | "project";
export const dashboardTabs: DashboardTab[];
export function nextDashboardTab(current: DashboardTab, key: string): DashboardTab | null;
