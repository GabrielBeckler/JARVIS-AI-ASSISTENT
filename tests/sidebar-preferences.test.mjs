import test from "node:test";
import assert from "node:assert/strict";
import { dropWithinSection, filterConversations, moveWithinSection, normalizeSidebarPreferences, orderConversations, restoreSidebarPreferences } from "../src/sidebarPreferences.js";

const conversations = [
  { id: "recent-a", title: "Plano Alpha", updatedAt: 10 },
  { id: "pinned", title: "Plano Beta", updatedAt: 8, pinned: true },
  { id: "archive", title: "Plano Gamma", updatedAt: 12, archived: true },
  { id: "recent-b", title: "Outra", updatedAt: 10 },
  { id: "locked", title: "Segredo", updatedAt: 13, locked: true },
];

test("filters combine state category with search without duplicating archived pins", () => {
  assert.deepEqual(filterConversations(conversations, "all", "plano").map(({ id }) => id), ["recent-a", "pinned", "archive"]);
  assert.deepEqual(filterConversations(conversations, "pinned", "plano").map(({ id }) => id), ["pinned"]);
  assert.deepEqual(filterConversations(conversations, "archived", "plano").map(({ id }) => id), ["archive"]);
  assert.deepEqual(filterConversations(conversations, "locked", "segredo").map(({ id }) => id), ["locked"]);
  assert.deepEqual(filterConversations([{ ...conversations[1], archived: true }], "pinned", ""), []);
});

test("updated ordering is newest first and stable when timestamps tie", () => {
  assert.deepEqual(orderConversations(conversations.slice(0, 4), "updated", []).map(({ id }) => id), ["archive", "recent-a", "recent-b", "pinned"]);
});

test("manual ordering and drag moves are isolated to their section", () => {
  const all = ["a", "p", "b", "archive", "c"];
  assert.deepEqual(moveWithinSection(all, ["a", "b", "c"], "b", -1), ["b", "p", "a", "archive", "c"]);
  assert.deepEqual(dropWithinSection(all, ["a", "b", "c"], "c", "a"), ["c", "p", "a", "archive", "b"]);
});

test("sidebar preferences survive JSON persistence and invalid input falls back safely", () => {
  const prefs = { organization: "project", sorting: "manual", filter: "archived", manualOrder: ["x", "y"] };
  assert.deepEqual(restoreSidebarPreferences(JSON.stringify(prefs)), prefs);
  assert.deepEqual(normalizeSidebarPreferences({ organization: "unknown", sorting: "bad", filter: "bad", manualOrder: [1] }), {
    organization: "list", sorting: "updated", filter: "all", manualOrder: [],
  });
  assert.equal(restoreSidebarPreferences("invalid-json").organization, "list");
});
