import test from "node:test";
import assert from "node:assert/strict";
import { isModelInstalled, toChatContext } from "../src/ollama.js";

test("recognizes Ollama model names without depending on the response field", () => {
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "qwen3.5:4b"), true);
  assert.equal(isModelInstalled([{ model: "llama3.2:latest" }], "llama3.2:latest"), true);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "missing:latest"), false);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "  QWEN3.5:4B  "), true);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], ""), false);
});

test("excludes failed or interrupted messages from Ollama context and removes UI-only fields", () => {
  assert.deepEqual(toChatContext([
    { role: "user", content: "Olá" },
    { role: "assistant", content: "Oi" },
    { role: "user", content: "Falhou", delivery: "failed" },
    { role: "user", content: "Interrompida", delivery: "pending" },
  ]), [
    { role: "user", content: "Olá" },
    { role: "assistant", content: "Oi" },
  ]);
});
