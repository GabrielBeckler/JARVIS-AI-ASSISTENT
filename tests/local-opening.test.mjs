import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage } from "../src/MarkdownMessage.js";
import { LocalResultPath, LocalToolMessage } from "../src/LocalToolMessage.js";
import { isSameLocalList, latestLocalContext, localRequestFor, resolveLocalReference } from "../src/localTools.js";
import { searchQueryFor } from "../src/webSearch.js";

test("routes written and dictated opening commands locally and preserves VS Code", () => {
  const cases = [
    ["Abra a imagem fotogabriel.jpeg em Downloads.", "image", "fotogabriel.jpeg"],
    ["Abra o PDF A TERCEIRA MARGEM DO RIO em Downloads.", "pdf", "A TERCEIRA MARGEM DO RIO"],
    ["Abra a pasta automacao em Downloads.", "directory", "automacao"],
    ["Abra o arquivo README.md da pasta Downloads.", "file", "README.md"],
    ["Jota, abra o vídeo ação [1].mp4 em Downloads.", "video", "ação [1].mp4"],
  ];
  for (const [text, targetKind, fileName] of cases) {
    assert.deepEqual(localRequestFor(text), { intent: { action: "open_item", targetKind, downloads: true, fileName } });
    assert.equal(searchQueryFor(text), undefined);
  }
  assert.deepEqual(localRequestFor("Abra /home/gbeck/Downloads/fotogabriel.jpeg."), {
    intent: { action: "open_item" }, selectedPath: "/home/gbeck/Downloads/fotogabriel.jpeg",
  });
  assert.equal(localRequestFor('Abra "/tmp/Ação & revisão.txt!"').selectedPath, "/tmp/Ação & revisão.txt!");
  assert.equal(localRequestFor("Mostre esse arquivo na pasta.").intent.action, "reveal_item");
  assert.equal(searchQueryFor("Mostre esse arquivo na pasta."), undefined);
  assert.equal(localRequestFor("Abra o projeto Aurion no VS Code.").intent.action, "open_project");
  assert.equal(localRequestFor("Abra /tmp/Aurion no VS Code.").intent.action, "open_project");
});

test("resolves the order of a real temporary list, checks changes, and isolates conversations", (t) => {
  const root = mkdtempSync(join(tmpdir(), "j-open-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "00 pasta"));
  for (const name of ["01 café.JPG", "02 margem.pdf", "03 margem cópia.PDF"]) writeFileSync(join(root, name), "sample");
  const listing = () => readdirSync(root, { withFileTypes: true })
    .map((item) => ({ path: join(root, item.name), kind: item.isDirectory() ? "directory" : "file" }));
  const list = { entries: listing(), truncated: false };
  const outputs = { "a-list": { list }, "b-file": { recent: { path: "/tmp/other.txt", kind: "file" } } };
  const context = latestLocalContext([{ id: "a-list" }], outputs);
  const first = localRequestFor("Abrir o primeiro arquivo.");
  const third = localRequestFor("Abra o terceiro item.");
  assert.equal(resolveLocalReference(first.reference, first.intent.targetKind, context.list).entry.path, join(root, "01 café.JPG"));
  assert.equal(resolveLocalReference(third.reference, third.intent.targetKind, context.list).entry.path, join(root, "02 margem.pdf"));
  const named = localRequestFor("Abra a pasta 00 pasta.");
  assert.equal(resolveLocalReference(named.reference, named.intent.targetKind, context.list).entry.path, join(root, "00 pasta"));
  const ambiguous = localRequestFor("Abra o PDF margem.");
  assert.equal(resolveLocalReference(ambiguous.reference, ambiguous.intent.targetKind, context.list).choices.length, 2);
  const other = latestLocalContext([{ id: "b-file" }], outputs);
  assert.match(resolveLocalReference(first.reference, first.intent.targetKind, other.list).message, /nova busca/);
  assert.match(resolveLocalReference(first.reference, first.intent.targetKind, { ...list, truncated: true }).message, /incompleta/);
  assert.equal(isSameLocalList(list, { status: "success", results: listing(), truncated: false }), true);
  rmSync(list.entries[1].path);
  assert.equal(isSameLocalList(list, { status: "success", results: listing(), truncated: false }), false);
  assert.equal(latestLocalContext([{ id: "a-list" }], {}).list, undefined);
});

test("intercepts only Ctrl and right click and uses a native keyboard button", () => {
  const opened = [];
  for (const entry of [{ path: "/tmp/café & imagem.jpg", kind: "file" }, { path: "/tmp/Pasta", kind: "directory" }]) {
    const button = LocalResultPath({ entry, onOpen: (item) => opened.push(item) });
    assert.equal(button.type, "button");
    assert.match(button.props.title, /Ctrl \+ clique direito.*Enter ou Espaço/);
    let prevented = 0;
    const event = { button: 2, preventDefault: () => prevented++ };
    button.props.onContextMenu({ ...event, ctrlKey: false });
    button.props.onContextMenu({ ...event, ctrlKey: true, button: 0 });
    assert.equal(prevented, 0);
    button.props.onContextMenu({ ...event, ctrlKey: true });
    button.props.onClick({ detail: 0 }); // Native button activation emits a click for Enter/Space.
    assert.equal(prevented, 1);
    assert.deepEqual(opened.splice(0), [entry, entry]);
  }
});

test("only structured local results render opening controls", () => {
  const path = "/tmp/a & b.pdf";
  const markdown = renderToStaticMarkup(createElement(MarkdownMessage, {
    content: `Texto de uma página: \`${path}\`. [arquivo](file:///tmp/a.pdf)`,
  }));
  assert.doesNotMatch(markdown, /<button|href="file:/);
  const local = renderToStaticMarkup(createElement(LocalToolMessage, {
    result: { action: "search", status: "success", message: "Encontrei:", results: [{ path, kind: "file" }] },
    onOpen: () => {},
  }));
  assert.match(local, /<button[^>]*type="button"/);
  assert.match(local, /a &amp; b\.pdf/);
});
