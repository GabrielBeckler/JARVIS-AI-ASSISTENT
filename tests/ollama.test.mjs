import test from "node:test";
import assert from "node:assert/strict";
import { appendAssistantOnce, captureScrollPosition, createRequestContext, isCurrentRequest, restoreConversations, restoreScrollTop, updateMessage } from "../src/chat.js";
import { isModelInstalled, limitChatContext, shouldUseFastMode, toChatContext } from "../src/ollama.js";

const emptyConversation = (id) => ({ id, title: "Nova conversa", updatedAt: 1, messages: [] });

test("recognizes Ollama model tags and reports a missing selection", () => {
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "qwen3.5:4b"), true);
  assert.equal(isModelInstalled([{ model: "llama3.2:latest" }], "llama3.2:latest"), true);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "missing:latest"), false);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], "  QWEN3.5:4B  "), true);
  assert.equal(isModelInstalled([{ name: "qwen3.5:4b" }], ""), false);
});

test("keeps prior history but excludes failed and in-flight attempts", () => {
  assert.deepEqual(toChatContext([
    { role: "user", content: "Legada sem metadados" },
    { role: "assistant", content: "Resposta legada" },
    { role: "user", content: "Falhou", delivery: "failed" },
    { role: "user", content: "Em envio", delivery: "pending" },
    { role: "user", content: "Enviada", delivery: "sent", model: "qwen3.5:4b", createdAt: 5 },
  ]), [
    { role: "user", content: "Legada sem metadados" },
    { role: "assistant", content: "Resposta legada" },
    { role: "user", content: "Enviada" },
  ]);
});

test("limits request context to recent complete turns while preserving system instructions and the current prompt", () => {
  const messages = [
    { role: "system", content: "Instrução essencial" },
    { role: "user", content: "antiga longa" },
    { role: "assistant", content: "resposta antiga" },
    { role: "user", content: "turno recente" },
    { role: "assistant", content: "resposta recente" },
    { role: "user", content: "pergunta atual 🌿" },
  ];
  assert.deepEqual(limitChatContext(messages, 64), [messages[0], ...messages.slice(3)]);
  assert.deepEqual(limitChatContext(messages, 1).slice(-1), [messages.at(-1)]);
});

test("uses fast mode only for short direct prompts without history", () => {
  assert.equal(shouldUseFastMode("Quanto é 2 + 2?"), true);
  assert.equal(shouldUseFastMode("Responda apenas com OK."), true);
  assert.equal(shouldUseFastMode("Olá"), true);
  assert.equal(shouldUseFastMode("Explique por que o céu é azul?"), false);
  assert.equal(shouldUseFastMode("Quanto é 2 + 2?", true), false);
});

test("restores legacy history, marks interrupted sends retryable, and leaves old metadata unknown", () => {
  const starter = [emptyConversation("starter")];
  const restored = restoreConversations(JSON.stringify([{
    id: "legacy", title: "Antiga", updatedAt: 10,
    messages: [{ role: "user", content: "Pergunta antiga" }, { role: "user", content: "Interrompida", delivery: "pending" }],
  }]), starter);
  assert.equal(restored[0].messages[0].model, undefined);
  assert.equal(restored[0].messages[0].createdAt, undefined);
  assert.equal(restored[0].messages[0].id, "legacy-legacy-0");
  assert.equal(restored[0].messages[1].delivery, "failed");
  assert.deepEqual(restoreConversations("not-json", starter), starter);
});

test("retries a failed prompt in place and appends one successful answer", () => {
  const conversation = emptyConversation("a");
  conversation.messages = [{ id: "question", role: "user", content: "Oi", model: "qwen3.5:4b", createdAt: 1, delivery: "failed" }];
  const retry = updateMessage([conversation], "a", "question", { delivery: "pending", requestId: "retry-1", createdAt: 2 });
  const sent = updateMessage(retry, "a", "question", { delivery: "sent" });
  const reply = { id: "answer", role: "assistant", content: "Olá", model: "qwen3.5:4b", createdAt: 3, delivery: "sent" };
  const withAnswer = appendAssistantOnce(sent, "a", "retry-1", reply);
  const duplicate = appendAssistantOnce(withAnswer, "a", "retry-1", reply);
  assert.equal(duplicate[0].messages.length, 2);
  assert.equal(duplicate[0].messages[0].delivery, "sent");
  assert.equal(duplicate[0].messages[1].content, "Olá");
  assert.deepEqual(toChatContext(duplicate[0].messages).map((message) => message.content), ["Oi", "Olá"]);
});

test("isolates two conversations and discards delayed replies after a request finishes", () => {
  const conversations = [emptyConversation("a"), emptyConversation("b")];
  const active = new Map([["a", "request-a"], ["b", "request-b"]]);
  assert.equal(isCurrentRequest(active, "a", "request-a"), true);
  assert.equal(isCurrentRequest(active, "b", "request-b"), true);
  const aReply = { id: "reply-a", role: "assistant", content: "A", model: "qwen3.5:4b", createdAt: 10, delivery: "sent" };
  const completed = appendAssistantOnce(conversations, "a", "request-a", aReply);
  active.delete("a");
  assert.equal(isCurrentRequest(active, "a", "request-a"), false);
  assert.equal(completed[0].messages.length, 1);
  assert.equal(completed[1].messages.length, 0);
  assert.equal(appendAssistantOnce(completed, "a", "request-a", aReply)[0].messages.length, 1);
});

test("keeps cancelled partial text incomplete and excludes it from future prompts", () => {
  const conversation = emptyConversation("cancelled");
  conversation.messages = [{ id: "question", role: "user", content: "Pergunta", requestId: "req-1", delivery: "pending" }];
  const withPartial = appendAssistantOnce([conversation], "cancelled", "req-1:partial", {
    id: "partial", role: "assistant", content: "Trecho incompleto", requestId: "req-1:partial", delivery: "failed",
  });
  const failedQuestion = updateMessage(withPartial, "cancelled", "question", { delivery: "failed" });
  assert.deepEqual(toChatContext(failedQuestion[0].messages), []);
  const active = new Map([["cancelled", "req-1"]]);
  active.delete("cancelled");
  assert.equal(isCurrentRequest(active, "cancelled", "req-1"), false);
});

test("captures the selected model and source conversation for each in-flight request", () => {
  const request = createRequestContext("conversation-a", "request-a", "model-v1");
  const selectedModel = "model-v2";
  const activeConversation = "conversation-b";
  assert.equal(selectedModel, "model-v2");
  assert.equal(activeConversation, "conversation-b");
  assert.deepEqual(request, { conversationId: "conversation-a", requestId: "request-a", model: "model-v1" });
  assert.equal(isCurrentRequest(new Map([[request.conversationId, request.requestId]]), request.conversationId, request.requestId), true);
});

test("follows the end only near it and restores an earlier reading position", () => {
  const reading = captureScrollPosition({ scrollTop: 400, scrollHeight: 1200, clientHeight: 500 });
  assert.deepEqual(reading, { scrollTop: 400, followBottom: false });
  assert.equal(restoreScrollTop({ scrollHeight: 1600, clientHeight: 500 }, reading), 400);

  const nearEnd = captureScrollPosition({ scrollTop: 650, scrollHeight: 1200, clientHeight: 500 });
  assert.equal(nearEnd.followBottom, true);
  assert.equal(restoreScrollTop({ scrollHeight: 1600, clientHeight: 500 }, nearEnd), 1100);
});
