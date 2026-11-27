import test from "node:test";
import assert from "node:assert/strict";
import { createSystemContextPrompt, isSystemQuestion } from "../src/systemContext.js";

const metric = (value, unit, reason = null) => ({ value, unit, reason });
const snapshot = {
  timestampMs: 1_000,
  platformName: "Fedora Linux",
  cpu: { name: "CPU local", nameReason: null, usagePercent: metric(22.3, "%") },
  memory: {
    usedBytes: metric(8 * 1_073_741_824, "bytes"),
    totalBytes: metric(16 * 1_073_741_824, "bytes"),
    usedPercent: metric(50, "%"),
    speedMtS: metric(null, "MT/s", "EDAC sem dados"),
  },
  gpu: {
    name: "GPU local", nameReason: null, usagePercent: metric(17, "%"),
    vramUsedBytes: metric(2 * 1_073_741_824, "bytes"),
    vramTotalBytes: metric(4 * 1_073_741_824, "bytes"),
  },
  temperatures: { cpuCelsius: metric(65, "°C"), gpuCelsius: metric(58.5, "°C") },
};

test("detects computer questions and system-related temperature follow-ups", () => {
  assert.equal(isSystemQuestion("Como está o desempenho do meu computador?"), true);
  assert.equal(isSystemQuestion("E a temperatura?", [{ role: "user", content: "Como está meu computador?" }]), true);
  assert.equal(isSystemQuestion("Qual é a temperatura?", [{ role: "assistant", content: "A GPU do computador está em uso." }]), true);
  assert.equal(isSystemQuestion("E a temperatura?", []), false);
  assert.equal(isSystemQuestion("Qual é o modelo da minha GPU?"), true);
  assert.equal(isSystemQuestion("Qual temperatura para assar pão?"), false);
});

test("keeps hardware definitions out of the system snapshot flow, including imperfect dictation", () => {
  const history = [{ role: "user", content: "Como está o desempenho do meu computador?" }];
  assert.equal(isSystemQuestion("Ei, Aurion, quero que você me fale o que é uma memória RAM em apenas uma frase simples.", history), false);
  assert.equal(isSystemQuestion("E é a hora que você me faz o que é uma memória, apenas uma frase simples.", history), false);
  assert.equal(isSystemQuestion("Quanto de memória RAM tem no meu computador?", history), true);
});

test("grounds installed Fedora questions without treating public Fedora releases as local", () => {
  const question = "Qual a versão do Fedora você está mesmo?";
  assert.equal(isSystemQuestion(question), true);
  assert.equal(isSystemQuestion("Qual a última versão do Fedora?"), false);
  assert.equal(isSystemQuestion("Qual a versão do Aurion instalada?"), false);
  assert.equal(createSystemContextPrompt(question, { platformName: "Fedora Linux 44 (KDE Plasma Desktop Edition)" }),
    "Sistema operacional instalado, lido de /etc/os-release: Fedora Linux 44 (KDE Plasma Desktop Edition).\nPara a pergunta atual, responda com esse nome exato.");
  assert.match(createSystemContextPrompt(question, null), /indisponível/);
});

test("includes current relevant hardware fields, units, sample time, and N/D without inventing values", () => {
  const prompt = createSystemContextPrompt("Como está o desempenho do meu computador?", snapshot, { now: 1_100 });
  assert.match(prompt, /Coletado em 1970-01-01T00:00:01\.000Z/);
  assert.match(prompt, /Uso da CPU: 22\.3 %/);
  assert.match(prompt, /RAM usada\/total: 8\.00 GiB \/ 16\.00 GiB; uso: 50 %/);
  assert.match(prompt, /GPU: GPU local/);
  assert.match(prompt, /Temperatura da GPU: 58\.5 °C/);
  assert.match(prompt, /N\/D \(EDAC sem dados\)/);
});

test("a follow-up temperature query includes a fresh reading and identifies stale data", () => {
  const prompt = createSystemContextPrompt("E a temperatura?", snapshot, { now: 7_000 });
  assert.match(prompt, /A amostra está desatualizada/);
  assert.match(prompt, /Temperatura da CPU: 65 °C/);
  assert.match(prompt, /Temperatura da GPU: 58\.5 °C/);
  assert.doesNotMatch(prompt, /^RAM usada\/total:/m);
});

test("a system collection failure explicitly forbids guessed values", () => {
  const prompt = createSystemContextPrompt("Como está o desempenho do computador?", null, { collectionFailed: true });
  assert.match(prompt, /coleta local desta pergunta falhou/i);
  assert.match(prompt, /não use valores presumidos/i);
  assert.doesNotMatch(prompt, /Uso da CPU:/);
});
