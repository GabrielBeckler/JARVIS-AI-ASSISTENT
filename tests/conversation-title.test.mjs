import test from "node:test";
import assert from "node:assert/strict";
import { createConversationTitle, countTitleGraphemes, resolveConversationTitle, validateConversationTitle } from "../src/conversationTitle.js";
import { renameConversationTitle, restoreConversations } from "../src/chat.js";

test("derives one-line titles from the first message with a 120-grapheme limit", () => {
  assert.equal(createConversationTitle("  Olá\n   mundo  "), "Olá mundo");
  const title = createConversationTitle("a".repeat(121));
  assert.equal(title, `${"a".repeat(119)}…`);
  assert.equal(countTitleGraphemes(title), 120);
});

test("never splits emoji or combining Unicode graphemes at the title limit", () => {
  const emoji = "👩‍💻";
  const emojiTitle = createConversationTitle(emoji.repeat(121));
  assert.equal(countTitleGraphemes(emojiTitle), 120);
  assert.equal(emojiTitle, `${emoji.repeat(119)}…`);

  const accented = "e\u0301";
  const accentedTitle = createConversationTitle(accented.repeat(121));
  assert.equal(countTitleGraphemes(accentedTitle), 120);
  assert.equal(accentedTitle, `${accented.repeat(119)}…`);
});

test("preserves existing long titles and derives missing titles from the earliest user turn", () => {
  const existing = "Título legado ".repeat(15);
  assert.equal(resolveConversationTitle(existing, [], "nova pergunta"), existing);
  assert.equal(resolveConversationTitle(undefined, [
    { role: "user", content: "Minha primeira pergunta" },
    { role: "assistant", content: "Resposta" },
  ], "seguimento"), "Minha primeira pergunta");

  const [reopened] = restoreConversations(JSON.stringify([{
    id: "renamed",
    title: existing,
    messages: [],
  }]), []);
  assert.equal(reopened.title, existing);
});

test("validates nonempty renamed titles by grapheme count", () => {
  assert.deepEqual(validateConversationTitle("  Café  "), { value: "Café", count: 4, valid: true });
  assert.equal(validateConversationTitle("  ").valid, false);
  assert.equal(validateConversationTitle("😀".repeat(120)).valid, true);
  assert.equal(validateConversationTitle("😀".repeat(121)).valid, false);
});

test("saves a renamed title without changing other conversations and restores it unchanged", () => {
  const conversations = [
    { id: "one", title: "Old", updatedAt: 1, messages: [] },
    { id: "two", title: "A legacy title that was already long".repeat(5), updatedAt: 2, messages: [] },
  ];
  const newTitle = "Nova conversa — ação 👩‍💻";
  const renamed = renameConversationTitle(conversations, "one", newTitle, 42);
  assert.equal(renamed[0].title, newTitle);
  assert.equal(renamed[0].updatedAt, 42);
  assert.equal(renamed[1].title, conversations[1].title);

  const [reopened] = restoreConversations(JSON.stringify(renamed), []);
  assert.equal(reopened.title, newTitle);
});
