import test from "node:test";
import assert from "node:assert/strict";
import { nextDashboardTab } from "../src/dashboardTabs.js";

test("dashboard tabs support cyclic arrow navigation and Home/End", () => {
  assert.equal(nextDashboardTab("system", "ArrowRight"), "ai");
  assert.equal(nextDashboardTab("project", "ArrowRight"), "system");
  assert.equal(nextDashboardTab("system", "ArrowLeft"), "project");
  assert.equal(nextDashboardTab("ai", "Home"), "system");
  assert.equal(nextDashboardTab("system", "End"), "project");
  assert.equal(nextDashboardTab("ai", "Enter"), null);
});
