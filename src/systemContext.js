const systemTerms = /\b(?:meu computador|meu pc|este computador|este pc|sistema|desempenho|performance|hardware|cpu|processador|gpu|placa de v[ií]deo|ram|mem[oó]ria|vram)\b/i;
const hardwareDefinition = /\bo\s+que\s+(?:[eé]|significa|s[aã]o)\s+(?:(?:o|a|os|as|um|uma)\s+)?(?:mem[oó]ria(?:\s+ram)?|ram|vram|cpu|gpu|processador|placa de v[ií]deo|hardware)\b/i;
const systemFollowUp = /^\s*(?:e|and)\s+(?:(?:a|o|os|as)\s+)?(?:temperatura|uso|desempenho|performance|cpu|processador|gpu|placa de v[ií]deo|ram|mem[oó]ria|vram|modelo)\b/i;

/** @param {string} prompt @param {readonly {role: string, content: string}[]} [history] */
export function isSystemQuestion(prompt, history = []) {
  if (hardwareDefinition.test(prompt)) return false;
  if (systemTerms.test(prompt)) return true;
  if (!/\btemperatura\b/i.test(prompt)) return false;
  const priorSystemQuestion = history.slice(-8).some((message) =>
    (message.role === "user" || message.role === "assistant") && systemTerms.test(message.content));
  return priorSystemQuestion && (systemFollowUp.test(prompt) || /\b(?:qual|como|está|esta)\b/i.test(prompt));
}

function metricText(metric) {
  if (!metric || metric.value == null || !Number.isFinite(metric.value)) {
    const reason = metric?.reason?.trim();
    return reason ? `N/D (${reason})` : "N/D (fonte indisponível)";
  }
  if (metric.unit === "bytes") return `${(metric.value / 1_073_741_824).toFixed(2)} GiB`;
  return `${Number(metric.value.toFixed(1))} ${metric.unit}`;
}

function staticName(value, reason) {
  return value?.trim() || (reason ? `N/D (${reason})` : "N/D (nome não identificado)");
}

/**
 * Produce a short, explicit system instruction from one local snapshot.
 * The timestamp is included so the model can identify stale or unavailable data.
 * @param {string} prompt
 * @param {import("./systemMonitor").SystemSnapshot | null} snapshot
 * @param {{collectionFailed?: boolean, now?: number, staleAfterMs?: number}} [options]
 */
export function createSystemContextPrompt(prompt, snapshot, options = {}) {
  const query = prompt.toLocaleLowerCase();
  const asksTemperature = /temperatura/.test(query);
  const asksGpu = /gpu|placa de v[ií]deo/.test(query);
  const asksCpu = /cpu|processador/.test(query);
  const asksMemory = /ram|mem[oó]ria|vram/.test(query);
  const asksStatic = /modelo|nome|qual [eéoa]/.test(query) && !/uso|temperatura|desempenho|performance/.test(query);
  const broadStatus = /desempenho|performance|sistema|computador|\bpc\b|hardware/.test(query);
  const includeCpu = asksCpu || broadStatus || asksTemperature && !asksGpu && !asksMemory;
  const includeGpu = asksGpu || broadStatus || asksTemperature && !asksCpu && !asksMemory;
  const includeMemory = asksMemory || broadStatus;
  const lines = [
    "Dados locais do computador para responder à pergunta atual.",
    "Use somente os valores abaixo; não estime nem invente valores. Explique qualquer N/D e não apresente dados antigos como atuais.",
  ];

  if (options.collectionFailed || !snapshot) {
    lines.push("A coleta local desta pergunta falhou. Informe que não foi possível consultar os dados atuais; não use valores presumidos.");
    return lines.join("\n");
  }

  const now = options.now ?? Date.now();
  const ageMs = Math.max(0, now - snapshot.timestampMs);
  const staleAfterMs = options.staleAfterMs ?? 5_000;
  lines.push(`Coletado em ${new Date(snapshot.timestampMs).toISOString()} (${Math.round(ageMs)} ms atrás).${ageMs > staleAfterMs ? " A amostra está desatualizada; avise o usuário." : ""}`);
  if (snapshot.platformName) lines.push(`Plataforma: ${snapshot.platformName}.`);

  if (includeCpu) {
    lines.push(`CPU: ${staticName(snapshot.cpu.name, snapshot.cpu.nameReason)}.`);
    if (!asksStatic || asksTemperature || broadStatus) lines.push(`Uso da CPU: ${metricText(snapshot.cpu.usagePercent)}.`);
    if (asksTemperature || broadStatus) lines.push(`Temperatura da CPU: ${metricText(snapshot.temperatures.cpuCelsius)}.`);
  }
  if (includeMemory && !asksStatic) {
    lines.push(`RAM usada/total: ${metricText(snapshot.memory.usedBytes)} / ${metricText(snapshot.memory.totalBytes)}; uso: ${metricText(snapshot.memory.usedPercent)}.`);
    if (/vram|gpu|desempenho|performance|sistema|computador|hardware/.test(query)) {
      lines.push(`Velocidade da RAM: ${metricText(snapshot.memory.speedMtS)}.`);
    }
  }
  if (includeGpu) {
    lines.push(`GPU: ${staticName(snapshot.gpu.name, snapshot.gpu.nameReason)}.`);
    if (!asksStatic || asksTemperature || broadStatus) {
      lines.push(`Uso da GPU: ${metricText(snapshot.gpu.usagePercent)}; VRAM usada/total: ${metricText(snapshot.gpu.vramUsedBytes)} / ${metricText(snapshot.gpu.vramTotalBytes)}.`);
    }
    if (asksTemperature || broadStatus) lines.push(`Temperatura da GPU: ${metricText(snapshot.temperatures.gpuCelsius)}.`);
  }
  return lines.join("\n");
}
