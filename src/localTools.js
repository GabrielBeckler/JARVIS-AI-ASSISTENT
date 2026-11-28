const prefix = /^(?:(?:ei|hey|oi)[,\s]+)?(?:jota|j)[,\s:]+/i;
const clean = (value) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");

/** Interprets a small, explicit Portuguese command set. No model-generated commands are accepted. */
export function localActionFor(input) {
  const text = input.trim().replace(prefix, "");
  const normalized = clean(text);
  let match;

  match = normalized.match(/^(?:abra|abrir|abra o projeto|abra projeto)\s+(.+?)\s+(?:no|pelo)\s+vs\s*code\s*[.!?]*$/i)
    ?? normalized.match(/^(?:abra|abrir)\s+(.+?)\s+no\s+(?:visual studio code|vscode)\s*[.!?]*$/i);
  if (match) return { action: "open_project", query: match[1].trim().replace(/^(?:o\s+)?projeto\s+/i, "") };

  match = normalized.match(/^(?:liste|listar|mostre|mostra)\s+(?:os\s+)?(?:arquivos|conteudo|itens)\s+(?:da|de|do|dos|das)\s+(?:pasta|diretorio|projeto)\s+(.+?)[.!?]*$/i);
  if (match) return { action: "list_directory", query: match[1].trim() };
  match = normalized.match(/^(?:liste|listar)\s+(?:os\s+)?arquivos\s+(?:de|em)\s+(.+?)[.!?]*$/i);
  if (match) return { action: "list_directory", query: match[1].trim() };

  match = normalized.match(/^(?:leia|ler|mostre|abra)\s+(?:o\s+)?arquivo\s+(.+?)[.!?]*$/i);
  if (match) return { action: "read_file", query: match[1].trim() };

  match = normalized.match(/^(?:encontre|encontrar|procure|procurar|busque|buscar|localize|localizar)\s+(?:o\s+)?(?:arquivo|pasta|diretorio)?\s*(.+?)(?:\s+(?:no|em)\s+(?:meu\s+)?computador)?[.!?]*$/i);
  if (match && /\b(?:arquivo|pasta|diretorio|computador|meu computador|readme|\w+\.\w{1,8})\b/.test(normalized)) {
    return { action: "search", query: match[1].trim().replace(/\s+(?:do|da|de)\s+projeto\s+/i, " ") };
  }
  return null;
}

export function localResultText(result) {
  const rows = result.results ?? [];
  if (result.status === "ambiguous") {
    return `${result.message}\n\n${rows.map((item, index) => `${index + 1}. ${item.kind === "directory" ? "Pasta" : "Arquivo"}: \`${item.path}\``).join("\n")}`;
  }
  if (result.status === "success" && result.action === "read_file") {
    const limited = result.truncated ? "\n\n[Conteúdo limitado; trecho inicial do arquivo.]" : "";
    return `Li o arquivo \`${result.path}\`.\n\n\`\`\`text\n${result.content ?? ""}\n\`\`\`${limited}`;
  }
  if (result.status === "success" && result.action === "list_directory") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁" : "📄"} \`${item.path}\``).join("\n")}` : ""}`;
  }
  if (result.status === "success" && result.action === "search") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁 Pasta" : "📄 Arquivo"}: \`${item.path}\``).join("\n")}` : ""}`;
  }
  return result.message;
}
