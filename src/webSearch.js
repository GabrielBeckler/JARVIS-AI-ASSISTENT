const assistantName = /^(?:(?:ei|hey|oi)[,\s]+)?(?:aurion|jota|j)[,\s:]+/i;
const webCommand = /^(?:pesquise|busque|procure|consulte)(?:\s+|$)(?:(?:na\s+(?:internet|web)|online)(?:[,\s:]+|$))?(?:sobre(?:\s+|$))?(?=\S|$)/i;
const explicitWeb = /\b(?:na internet|na web|online|fontes oficiais|com fontes|com referencias)\b/i;
const offlineOnly = /\b(?:sem\s+(?:(?:usar|consultar|buscar|pesquisar)\s+(?:(?:na|a)\s+)?)?(?:internet|web)|nao\s+(?:pesquise|busque|consulte)\b)/i;
const factualQuestion = /\b(?:o que (?:e|sao|significa|aconteceu)|que (?:dia|ano)|quem|quando|onde|qual|quais|quanto|quantos|como (?:esta|ficou|funciona|instalar|configurar)|por que|me (?:fale|conte|diga) sobre)\b/i;
const researchTopic = /\b(?:lancamentos?|lancou|estreia|pre-venda|noticias?|resultados?|cotacao|preco|previsao|ultim[ao]s?|mais recente|atualizac(?:ao|oes)|disponibilidade|ja saiu|ja esta disponivel|melhor(?:es)?|comprar|compativel|compatibilidade|suporta|requisitos|documentacao)\b/i;
const localRequest = /\b(?:meu|minha|neste|nesta|aqui no|aqui na)\s+(?:computador|pc|notebook|sistema|fedora|linux|processador|cpu|gpu|ram|vram|memoria|arquivo|projeto|conversa|conta|documento)\b/i;
const localFileCommand = /\b(?:encontre|encontrar|procure|procurar|busque|buscar|localize|localizar|leia|ler|abra|abrir|liste|listar|onde\s+(?:esta|fica))\b.*\b(?:arquivo|pasta|diretorio|projeto|readme|[\p{L}\p{N}_-]+\.[\p{L}\p{N}]{1,10})\b/iu;
const localWork = /^(?:traduza|reescreva|revise|formate|resuma|crie|escreva|invente|corrija|calcule|explique (?:a frase|o trecho|o texto|o erro abaixo)|analise (?:o texto|o trecho|os dados|os resultados que)|me ajude a (?:escrever|criar)|(?:faca|monte) (?:uma? )?(?:redacao|mensagem|historia|poema|lista|plano))\b/i;
const basicQuestion = /^(?:(?:oi|ola|bom dia|boa tarde|boa noite|obrigad[oa]|valeu)[!.?]*$|(?:quem e voce|qual (?:e )?o seu nome|que (?:dia|horas?) (?:e|sao)|qual (?:e )?(?:a data de hoje|o horario agora))\b|quanto e\s+[\d\s+*/.,()%-]+\??$)/i;
const basicDefinition = /\bo que (?:e|sao)\s+(?:(?:o|a|os|as|um|uma)\s+)?(?:memoria ram|memoria|ram|vram|cpu|gpu|processador)\b/i;
const followUp = /^(?:e\s+(?!o que e\b)|(?:isso|ele|ela)\s+|ja\s+(?:saiu|lancou)\b|tem\s+(?:para|pra)\b)/i;
const credential = /\b(?:ollama_api_key|api[_ -]?key|senha|token de acesso|chave api|cpf)\b\s*(?:=|:|\u00e9\s)/i;
const sourcesMarker = "\n\n<!-- aurion:web-sources -->\n";

function normalize(text) {
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function cleanQuestion(text) {
  return text.trim().replace(assistantName, "");
}

function explicitQuery(text) {
  const command = text.match(webCommand);
  return command ? text.slice(command[0].length).trim() : undefined;
}

/**
 * Reuse a previously searched topic only for short continuations after a sourced answer.
 * @param {readonly {role: string, content: string, delivery?: string}[]} messages
 */
function previousWebTopic(messages) {
  const completed = messages.filter((item) => item.delivery !== "failed" && item.delivery !== "pending");
  for (let index = completed.length - 1; index > 0; index -= 2) {
    const answer = completed[index];
    const question = completed[index - 1];
    if (answer.role !== "assistant" || !webSourcesMarkdown(answer.content) || question.role !== "user") break;
    const text = cleanQuestion(question.content);
    const query = explicitQuery(text) ?? text;
    if (query && !followUp.test(normalize(query))) return query;
  }
  return undefined;
}

/**
 * @param {string} message
 * @param {{systemQuestion?: boolean, history?: readonly {role: string, content: string, delivery?: string}[]}} [options]
 */
export function searchQueryFor(message, { systemQuestion = false, history = [] } = {}) {
  const text = cleanQuestion(message);
  if (!text || text.length > 500 || /[\r\n]/.test(text) || credential.test(text)) return undefined;
  const query = normalize(text);
  if (offlineOnly.test(query)) return undefined;
  const explicit = explicitQuery(text);
  if (explicit !== undefined) {
    return !localRequest.test(query) || explicitWeb.test(query) ? explicit || undefined : undefined;
  }
  if (localRequest.test(query) || localFileCommand.test(query) || basicQuestion.test(query) || localWork.test(query)) return undefined;

  if (followUp.test(query) && text.length <= 100) {
    const topic = previousWebTopic(history);
    if (topic) {
      const continuation = `${topic} ${text}`;
      return continuation.length <= 500 ? continuation : undefined;
    }
  }
  if (explicitWeb.test(query)) return text;
  if (researchTopic.test(query)) return text;
  if (systemQuestion) return undefined;
  if (basicDefinition.test(query)) return undefined;
  if (factualQuestion.test(query)) return text;
  return undefined;
}

/** @param {string} answer @param {{title: string, url: string}[]} [sources] */
export function appendWebSources(answer, sources = []) {
  if (!sources.length) return answer;
  const links = sources.map(({ title, url }, index) => {
    const label = (title || new URL(url).hostname).replace(/[\\[\]<>*_&]/g, "\\$&");
    return `${index + 1}. [${label}](<${url}>)`;
  });
  return `${answer.trimEnd()}${sourcesMarker}### Fontes da web\n\n${links.join("\n")}`;
}

/** @param {string} answer */
export function withoutWebSources(answer) {
  const start = answer.lastIndexOf(sourcesMarker);
  return start === -1 ? answer : answer.slice(0, start);
}

/** @param {string} answer */
export function webSourcesMarkdown(answer) {
  const start = answer.lastIndexOf(sourcesMarker);
  return start === -1 ? "" : answer.slice(start + sourcesMarker.length);
}
