import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeExportFilename } from "../src/exportFilename.js";

test("sanitizes filesystem-invalid export title characters, including quotes and backslashes", () => {
  assert.equal(sanitizeExportFilename('Plano: "A/B"?*<C>|\\D'), "Plano- -A-B----C---D");
});

test("keeps Unicode and enforces the existing 100 character filename limit", () => {
  assert.equal(sanitizeExportFilename("ação_日本").startsWith("ação_日本"), true);
  assert.equal(sanitizeExportFilename("a".repeat(150)).length, 100);
});

test("uses the existing fallback for an empty title", () => {
  assert.equal(sanitizeExportFilename(""), "conversa");
});
