import test from "node:test";
import assert from "node:assert/strict";
import { clampLayoutWidths, DASHBOARD_MAX_WIDTH, DASHBOARD_MIN_WIDTH, defaultLayoutWidths, getLayoutLimits, restoreLayoutWidths, resizeLayoutArea, SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../src/layoutSizing.js";

test("restores saved widths and safely falls back for invalid persistence", () => {
  assert.deepEqual(restoreLayoutWidths(JSON.stringify({ sidebarWidth: 275, dashboardWidth: 330 })), { sidebarWidth: 275, dashboardWidth: 330 });
  assert.deepEqual(restoreLayoutWidths("invalid"), defaultLayoutWidths);
  assert.deepEqual(restoreLayoutWidths(JSON.stringify({ sidebarWidth: "wide" })), defaultLayoutWidths);
});

test("clamps both areas so the center remains at least 420px and all rails stay accessible", () => {
  for (const width of [1000, 1440]) {
    const layout = clampLayoutWidths({ sidebarWidth: 1000, dashboardWidth: 1000 }, width);
    const limits = getLayoutLimits(layout, width);
    assert.ok(layout.sidebarWidth >= limits.sidebar.min && layout.sidebarWidth <= limits.sidebar.max);
    assert.ok(layout.dashboardWidth >= limits.dashboard.min && layout.dashboardWidth <= limits.dashboard.max);
    assert.ok(width - layout.sidebarWidth - layout.dashboardWidth - 14 >= 420);
  }
});

test("pointer and keyboard resizing update either rail and respect bounds", () => {
  const initial = { sidebarWidth: 238, dashboardWidth: 304 };
  const widerLeft = resizeLayoutArea(initial, "sidebar", 32, 1440);
  assert.equal(widerLeft.sidebarWidth, 270);
  const widerDashboard = resizeLayoutArea(widerLeft, "dashboard", 24, 1440);
  assert.equal(widerDashboard.dashboardWidth, 328);
  const maxDashboard = resizeLayoutArea(widerDashboard, "dashboard", 10000, 1440);
  assert.equal(maxDashboard.dashboardWidth, DASHBOARD_MAX_WIDTH);
  const minDashboard = resizeLayoutArea(maxDashboard, "dashboard", -10000, 1440);
  assert.equal(minDashboard.dashboardWidth, DASHBOARD_MIN_WIDTH);
  const maxSidebar = resizeLayoutArea(initial, "sidebar", 10000, 1440);
  assert.equal(maxSidebar.sidebarWidth, SIDEBAR_MAX_WIDTH);
  const minSidebar = resizeLayoutArea(maxSidebar, "sidebar", -10000, 1440);
  assert.equal(minSidebar.sidebarWidth, SIDEBAR_MIN_WIDTH);
  assert.deepEqual(restoreLayoutWidths(JSON.stringify(maxSidebar)), maxSidebar);
});

test("compact windows constrain only the visible layout and resizing one rail keeps the other", () => {
  const preferred = { sidebarWidth: 320, dashboardWidth: 380 };
  const compact = clampLayoutWidths(preferred, 1000);
  assert.deepEqual(clampLayoutWidths(preferred, 1440), preferred);
  assert.deepEqual(restoreLayoutWidths(JSON.stringify(preferred)), preferred);
  const leftLimit = getLayoutLimits(compact, 1000).sidebar.max;
  assert.deepEqual(resizeLayoutArea(compact, "sidebar", 1000, 1000), { ...compact, sidebarWidth: leftLimit });
  const roomierSidebar = resizeLayoutArea(compact, "sidebar", -70, 1000);
  assert.ok(roomierSidebar.sidebarWidth < compact.sidebarWidth);
  assert.equal(roomierSidebar.dashboardWidth, compact.dashboardWidth);
  const rightLimit = getLayoutLimits(roomierSidebar, 1000).dashboard.max;
  assert.deepEqual(resizeLayoutArea(roomierSidebar, "dashboard", 1000, 1000), { ...roomierSidebar, dashboardWidth: rightLimit });
});
