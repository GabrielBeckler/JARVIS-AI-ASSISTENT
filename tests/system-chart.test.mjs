import test from "node:test";
import assert from "node:assert/strict";
import { chartPath } from "../src/systemChart.js";

test("plots only values from the last minute using their timestamps", () => {
  assert.equal(chartPath([
    { timestampMs: 9_999, value: 90 },
    { timestampMs: 66_000, value: 0 },
    { timestampMs: 68_000, value: 50 },
    { timestampMs: 70_000, value: 100 },
  ], 70_000, 2_000), "M 91.60 68.00 h 0 L 94.80 37.00 L 98.00 6.00");
});

test("skips unavailable readings and does not draw across outages", () => {
  assert.equal(chartPath([
    { timestampMs: 52_000, value: 10 },
    { timestampMs: 54_000, value: null },
    { timestampMs: 56_000, value: 20 },
    { timestampMs: 68_000, value: 30 },
  ], 70_000, 2_000), "M 69.20 61.80 h 0 M 75.60 55.60 h 0 M 94.80 49.40 h 0");
  assert.equal(chartPath([{ timestampMs: 70_000, value: null }], 70_000, 2_000), "");
});
