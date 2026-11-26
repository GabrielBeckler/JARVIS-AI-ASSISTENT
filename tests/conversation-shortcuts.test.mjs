import test from "node:test";
import assert from "node:assert/strict";
import { getConversationShortcut } from "../src/conversationShortcuts.js";

const keyEvent = (key, changes = {}) => ({
  key, ctrlKey: true, altKey: false, metaKey: false, shiftKey: false,
  repeat: false, defaultPrevented: false, isComposing: false, ...changes,
});

test("maps Ctrl+K and Ctrl+F while allowing text inputs to retain normal typing", () => {
  assert.equal(getConversationShortcut(keyEvent("k")), "new_conversation");
  assert.equal(getConversationShortcut(keyEvent("F")), "focus_search");
  assert.equal(getConversationShortcut(keyEvent("k"), false), "new_conversation");
});

test("ignores repeated, modified, pre-handled, and IME composing key events", () => {
  assert.equal(getConversationShortcut(keyEvent("k", { repeat: true })), null);
  assert.equal(getConversationShortcut(keyEvent("f", { shiftKey: true })), null);
  assert.equal(getConversationShortcut(keyEvent("f", { altKey: true })), null);
  assert.equal(getConversationShortcut(keyEvent("f", { metaKey: true })), null);
  assert.equal(getConversationShortcut(keyEvent("k", { defaultPrevented: true })), null);
  assert.equal(getConversationShortcut(keyEvent("k", { isComposing: true })), null);
});

test("leaves Escape, Enter, and ordinary typing alone and ignores open menus or dialogs", () => {
  assert.equal(getConversationShortcut(keyEvent("Escape")), null);
  assert.equal(getConversationShortcut(keyEvent("Enter")), null);
  assert.equal(getConversationShortcut(keyEvent("a", { ctrlKey: false })), null);
  assert.equal(getConversationShortcut(keyEvent("k"), true), null);
});
