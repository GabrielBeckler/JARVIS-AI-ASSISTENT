import test from "node:test";
import assert from "node:assert/strict";
import { prepareSpeech, restoreVoiceVolume, SpeechChunks } from "../src/voiceText.js";

test("prepares voice text without changing written Markdown", () => {
  const source = "## Olá! 😄\n\n1. Use **negrito** e *itálico*.\n2. Abra [o manual](https://example.test/caminho.longo) ou https://example.test/oculto.\n\n```js\nconsole.log('segredo');\n```\n\nUse a opção `ajuda`. 🇧🇷";
  const original = source.slice();
  assert.equal(prepareSpeech(source), "Olá! Use negrito e itálico. Abra o manual ou. Há um bloco de código na resposta. Use a opção ajuda.");
  assert.equal(source, original);
});

test("starts at a stable phrase and finishes once without repeating previous fragments", () => {
  const chunks = new SpeechChunks();
  assert.deepEqual(chunks.push("Esta é uma **primeira frase."), []);
  assert.deepEqual(chunks.push("** "), ["Esta é uma primeira frase."]);
  assert.deepEqual(chunks.push("A segunda frase fica para o fim!"), []);
  assert.deepEqual(chunks.finish(), ["A segunda frase fica para o fim!"]);
  assert.deepEqual(chunks.finish(), []);
});

test("never splits a long fenced code block or speaks an unfinished URL", () => {
  const chunks = new SpeechChunks();
  assert.deepEqual(chunks.push("Abra [a documentação oficial](https://exemplo.test/"), []);
  assert.deepEqual(chunks.push("manual?x=y) para saber mais. "), ["Abra a documentação oficial para saber mais."]);
  assert.deepEqual(chunks.push("\n```js\n" + "const x = 2;\n".repeat(50)), []);
  const speech = [...chunks.push("```\nFim obrigatório."), ...chunks.finish()];
  assert.equal(speech.join(" "), "Há um bloco de código na resposta. Fim obrigatório.");
});

test("uses a safe break for very long prose and preserves the trailing text", () => {
  const chunks = new SpeechChunks();
  const input = "palavra ".repeat(45) + "fim";
  const speech = [...chunks.push(input), ...chunks.finish()].join(" ");
  assert.equal(speech.match(/palavra/gu)?.length, 45);
  assert.match(speech, /fim\.$/u);
});

test("restores the stored volume without accepting out-of-range or corrupt values", () => {
  assert.equal(restoreVoiceVolume("0"), 0);
  assert.equal(restoreVoiceVolume("62"), 62);
  for (const value of [null, "", "   ", "-1", "101", "3.5", "NaN"]) assert.equal(restoreVoiceVolume(value), 100);
});
