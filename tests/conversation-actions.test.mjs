import test from "node:test";
import assert from "node:assert/strict";
import { exportConversationMarkdown, removeConversation, updateConversationFlags } from "../src/chat.js";

const conversations = [
  { id: "a", title: "Uma", pinned: false, archived: false, messages: [] },
  { id: "b", title: "Duas", pinned: false, archived: false, messages: [] },
];

test("pin and archive changes apply only to the selected conversation and survive JSON re-open", () => {
  const changed = updateConversationFlags(conversations, "b", { pinned: true, archived: true });
  assert.equal(changed[0].pinned, false);
  assert.deepEqual(JSON.parse(JSON.stringify(changed))[1], { ...conversations[1], pinned: true, archived: true });
  assert.deepEqual(updateConversationFlags(changed, "b", { archived: false })[1], { ...conversations[1], pinned: true, archived: false });
});

test("deletion removes only the chosen conversation", () => {
  assert.deepEqual(removeConversation(conversations, "a"), [conversations[1]]);
});

test("Markdown export keeps title, roles, and original Markdown content", () => {
  const markdown = exportConversationMarkdown({ title: "Ajustes", messages: [
    { role: "system", content: "hidden prompt" },
    { role: "user", content: "### Olá" },
    { role: "assistant", content: "**Resposta**" },
  ] });
  assert.equal(markdown, "# Ajustes\n\n## Você\n\n### Olá\n\n---\n\n## JARVIS\n\n**Resposta**\n");
  assert.equal(markdown.includes("hidden prompt"), false);
});
