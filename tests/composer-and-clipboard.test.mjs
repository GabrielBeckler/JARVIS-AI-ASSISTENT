import test from "node:test";
import assert from "node:assert/strict";
import { calculateComposerSize } from "../src/composerSizing.js";
import { copyResponseText } from "../src/clipboard.js";

test("composer sizing grows to ten lines, scrolls beyond it, and shrinks to one line", () => {
  const oneLine = calculateComposerSize(28, 20, 4, 4);
  assert.deepEqual(oneLine, { height: 28, maxHeight: 208, overflowY: "hidden" });

  const tenLines = calculateComposerSize(208, 20, 4, 4);
  assert.deepEqual(tenLines, { height: 208, maxHeight: 208, overflowY: "hidden" });

  const moreThanTen = calculateComposerSize(500, 20, 4, 4);
  assert.deepEqual(moreThanTen, { height: 208, maxHeight: 208, overflowY: "auto" });

  const afterDelete = calculateComposerSize(22, 20, 4, 4);
  assert.deepEqual(afterDelete, { height: 28, maxHeight: 208, overflowY: "hidden" });
});

test("clipboard copies only the raw selected response, preserving Markdown and newlines", async () => {
  const markdown = "## Resumo\n\n- **RAM:** `8 GiB`\n\n```js\nconsole.log('🌿')\n```";
  let copied = null;
  await copyResponseText(markdown, { writeText: async (value) => { copied = value; } });
  assert.equal(copied, markdown);
});

test("clipboard failures are reported to the caller", async () => {
  await assert.rejects(
    copyResponseText("resposta", { writeText: async () => { throw new Error("permission denied"); } }),
    /permission denied/,
  );
});

test("clipboard API rejection falls back to the Tauri WebView document command", async () => {
  let copied = null;
  const field = {
    value: "",
    style: {},
    setAttribute() {},
    select() {},
    remove() {},
  };
  const documentObject = {
    body: { appendChild: () => {} },
    createElement: () => field,
    execCommand: (command) => { copied = command === "copy" ? field.value : null; return command === "copy"; },
  };
  await copyResponseText("resposta\n- item", { writeText: async () => { throw new Error("permission denied"); } }, documentObject);
  assert.equal(copied, "resposta\n- item");
});
