import test from "node:test";
import assert from "node:assert/strict";
import { isModelInstalled, readOllamaChatStream, shouldUseFastMode, toChatContext } from "../src/ollama.js";

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

test("uses fast mode only for short, direct prompts without conversation history", () => {
  assert.equal(shouldUseFastMode("Quanto é 2 + 2?"), true);
  assert.equal(shouldUseFastMode("Responda apenas com OK."), true);
  assert.equal(shouldUseFastMode("Olá"), true);
  assert.equal(shouldUseFastMode("Explique por que o céu é azul?"), false);
  assert.equal(shouldUseFastMode("Quanto é 2 + 2?", true), false);
  assert.equal(shouldUseFastMode("x".repeat(121) + "?"), false);
});

test("reassembles Ollama NDJSON chunks and streams only answer content", async () => {
  const chunks = [
    JSON.stringify({ message: { thinking: "hidden reasoning" }, done: false }) + "\n",
    JSON.stringify({ message: { content: "O" }, done: false }) + "\n",
    JSON.stringify({ message: { content: "K" }, done: true, eval_count: 2 }) + "\n",
  ].join("");
  const bytes = new TextEncoder().encode(chunks);
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 17));
      controller.enqueue(bytes.slice(17, 85));
      controller.enqueue(bytes.slice(85));
      controller.close();
    },
  });
  const updates = [];
  const result = await readOllamaChatStream(body, (content) => updates.push(content));
  assert.deepEqual(updates, ["O", "OK"]);
  assert.equal(result.content, "OK");
  assert.equal(result.final.eval_count, 2);
});
