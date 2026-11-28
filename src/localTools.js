const prefix = /^(?:(?:ei|hey|oi)[,\s]+)?(?:jota|j)[,\s:]+/i;
export const LOCAL_TOOL_MODEL = "ferramenta local";
const normalize = (value) => value.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
const trailing = /[\s,.!?;:]+$/u;
const stopWords = /\s+(?:(?:o|a)\s+)?(?:projeto|pasta|diretorio|no\s+vs\s*code|no\s+vscode|usando\s+o?\s*vs\s*code|com\s+o?\s*vs\s*code|pelo\s+vs\s*code|na\s+pasta|no\s+diretorio)\b/i;

function captureBeforeStop(value) {
  return value.split(stopWords, 1)[0].replace(trailing, "").trim();
}

function findSearchRoot(text) {
  const match = text.match(/\b(?:dentro\s+(?:de|da|do)|na|no|em)\s+(?:pasta|diret[oó]rio)\s+(.+?)(?=\s+(?:(?:o|a)\s+)?projeto\b|\s+no\s+(?:vs\s*code|vscode)|[,;]|$)/i)
    ?? text.match(/\b(?:dentro\s+de|em)\s+([\p{L}\p{N}_~./ -]+?)(?=\s+(?:(?:o|a)\s+)?projeto\b|\s+no\s+(?:vs\s*code|vscode)|[,;]|$)/iu);
  if (!match) return undefined;
  const value = match[1].trim().replace(/\s+(?:no|pelo|usando\s+(?:o\s+)?)\s*(?:visual\s+studio\s+code|vs\s*code|vscode).*$/i, "").replace(trailing, "");
  if (!value || /^(?:no|na|no\s+vs\s*code|no\s+vscode|pelo\s+vs\s*code|vs\s*code|vscode)$/i.test(normalize(value))) return undefined;
  return value;
}

function findProjectName(text, scope) {
  const project = text.match(/\bprojeto\s+(.+?)(?=\s+(?:na|no|em|dentro\b|usando\b|com\b|pelo\b)|[,;.!?]|$)/i);
  if (project) {
    const name = project[1].trim().replace(trailing, "");
    if (!/^(?:no|na|em)\s+(?:vs\s*code|vscode|visual\s+studio\s+code)$/i.test(name)) return name;
  }

  const file = findFileName(text);
  if (file) {
    const tail = text.slice(text.indexOf(file) + file.length);
    const owner = tail.match(/^\s+(?:do|da|de)\s+(.+?)(?=\s+(?:na|no|em|usando|com|pelo)\b|[,;.!?]|$)/i);
    if (owner) return owner[1].trim().replace(/^(?:(?:o|a)\s+)?(?:projeto|pasta|diretorio)\s+/i, "");
  }

  const withoutScope = scope ? text.replace(scope, " ") : text;
  const folder = withoutScope.match(/\b(?:pasta|diret[oó]rio)\s+(.+?)(?=\s+(?:na|no|em|dentro\b|usando\b|com\b|pelo\b)|[,;.!?]|$)/i);
  return folder?.[1]?.trim().replace(trailing, "");
}

function findFileName(text) {
  const readme = text.match(/\b(README(?:\.md)?)\b/i);
  if (readme) return readme[1];
  const withSpaces = text.match(/\barquivo\s+(.+?\.[\p{L}\p{N}]{1,10})(?=\s+(?:do|da|de|no|na|em|dentro|projeto)\b|[,;.!?]|$)/iu);
  if (withSpaces) return withSpaces[1].trim().replace(trailing, "");
  const name = text.match(/(?:^|\s)([\p{L}\p{N}_][\p{L}\p{N}_.-]*\.[\p{L}\p{N}]{1,10})\b/iu);
  return name?.[1]?.trim().replace(trailing, "");
}

function clarification(action) {
  if (action === "open_project") return "Qual projeto você quer abrir? Informe o nome ou o caminho da pasta.";
  if (action === "read_file") return "Qual arquivo devo ler? Informe o nome do arquivo ou o projeto onde devo procurá-lo.";
  if (action === "list_directory") return "Qual pasta devo listar? Informe o nome ou o caminho da pasta.";
  return "O que devo procurar? Informe o nome do arquivo ou da pasta.";
}

const absolutePath = /^(?:`(\/[^\r\n]*?)`|"(\/[^\r\n]*?)"|'(\/[^\r\n]*?)'|(\/[^\r\n]*))$/u;
const pathFrom = (text) => text?.trim().match(absolutePath)?.slice(1).find((value) => value !== undefined);

export function localRequestFor(input, pendingChoice) {
  const text = input.trim().replace(prefix, "").trim();
  const path = pathFrom(text);
  if (path) {
    return { intent: pendingChoice ?? { action: "inspect_path" }, selectedPath: path };
  }

  const explicit = text.match(/^(leia|ler|liste|listar|encontre|procure|busque|localize|abra|abrir)\s+(?:(?:o|a)\s+)?(?:(?:arquivo|pasta|projeto)\s+)?(.+)$/i);
  if (explicit) {
    const verb = explicit[1].toLowerCase();
    const opening = ["abra", "abrir"].includes(verb);
    const operand = opening ? explicit[2].match(/^(.+?)\s+(?:no|pelo)\s+(?:visual studio code|vs\s*code|vscode)[.!?]*$/i)?.[1] : explicit[2];
    const target = pathFrom(operand);
    if (target) {
      const action = opening ? "open_project" : ["leia", "ler"].includes(verb) ? "read_file" : ["liste", "listar"].includes(verb) ? "list_directory" : "search";
      return { intent: { action }, selectedPath: target };
    }
  }

  const intent = localActionFor(text);
  return intent ? { intent } : null;
}

function downloadsRequest(text) {
  const lower = normalize(text);
  const mentionsDownloads = /\b(?:pasta|diretorio)\s+(?:de\s+)?(?:downloads?|dowloads?)\b|\b(?:de|da|dos|nas?)\s+(?:downloads?|dowloads?)\b|\barquivos?\s+que\s+(?:eu\s+)?baixei\b|\bbaixados?\b/.test(lower);
  const hasListingIntent = /\b(?:liste|listar|list|mostre|mostrar|mostra|exiba|exibir|apresente|apresentar|quais|qual|tem|existe)\b/.test(lower)
    || /\bttod\b/.test(lower);
  const hasItems = /\b(?:arquivos?|imagens?|fotos?|figuras?|pdfs?|documentos?)\b/.test(lower);
  if (!(mentionsDownloads && (hasListingIntent || /\barquivos?\s+que\s+(?:eu\s+)?baixei\b/.test(lower)) && hasItems)) return null;

  const filter = /\b(?:imagens?|fotos?|figuras?)\b/.test(lower)
    ? "images"
    : /\bpdfs?\b|\barquivos?\s+pdf\b/.test(lower) ? "pdf" : "all";
  const recursive = /\b(?:subpastas?|subdiretorios?|subfolders?|recursiv[oa]|incluindo\s+(?:as\s+)?subpastas?|em\s+todas\s+as\s+pastas)\b/.test(lower);
  return { action: "list_directory", downloads: true, fileFilter: filter, recursive };
}

/** Parse a local request into validated intent fields; no model-generated command is accepted. */
export function localActionFor(input) {
  const text = input.trim().replace(prefix, "");
  const lower = normalize(text);
  const downloads = downloadsRequest(text);
  if (downloads) return downloads;
  const action = /\b(?:abra|abrir|abre|open)\b/i.test(lower) && /\b(?:vs\s*code|vscode|visual studio code)\b/i.test(lower)
    ? "open_project"
    : /\b(?:liste|listar|mostre|mostra)\b/i.test(lower) && /\b(?:arquivos|conteudo|itens|pasta|diretorio)\b/i.test(lower)
      ? "list_directory"
      : /^(?:\s*)(?:leia|ler|mostre|read)\b/i.test(lower) && /\b(?:readme|arquivo|\.\w{1,10})\b/i.test(lower)
        ? "read_file"
        : /\b(?:encontre|encontrar|procure|procurar|busque|buscar|localize|localizar|onde\s+(?:esta|est[aá])|where\s+is)\b/i.test(lower)
          ? "search"
          : null;
  if (!action) return null;
  if (action === "search" && /\b(?:na internet|na web|online)\b/i.test(lower)) return null;

  let searchRoot = findSearchRoot(text);
  const fileName = findFileName(text);
  let projectName = findProjectName(text, searchRoot);

  if (action === "open_project") {
    if (!projectName) {
      let remainder = text.replace(prefix, "");
      remainder = remainder.replace(/\b(?:abra|abrir|abre|open)\b/ig, " ");
      remainder = remainder.replace(/\b(?:no|pelo|usando|com)\s+(?:o\s+)?(?:visual\s+studio\s+code|vs\s*code|vscode)\b/ig, " ");
      remainder = remainder.replace(/\b(?:na|em|dentro\s+(?:da|de))\s+(?:pasta|diretorio)\b/ig, " ");
      remainder = remainder.replace(/\b(?:o|a)?\s*projeto\b/ig, " ");
      projectName = captureBeforeStop(remainder).replace(trailing, "").trim();
    }
  }

  if (action === "list_directory" && !projectName) {
    const direct = text.match(/\b(?:pasta|diret[oó]rio)\s+(.+?)(?=\s+(?:na|no|em|dentro\b)|[,;.!?]|$)/i);
    projectName = direct?.[1]?.trim().replace(trailing, "");
  }
  if (action === "list_directory" && searchRoot && projectName && normalize(projectName) === normalize(searchRoot)) projectName = undefined;
  if (action === "list_directory" && projectName && !/\bprojeto\b/i.test(text)) {
    searchRoot ??= projectName;
    projectName = undefined;
  }

  if (action === "search" && !projectName && !fileName) {
    const direct = text.match(/\b(?:arquivo|pasta|diret[oó]rio|projeto)\s+(.+?)(?=\s+(?:na|no|em|dentro\b)|[,;.!?]|$)/i);
    projectName = direct?.[1]?.trim().replace(trailing, "");
  }
  if (action === "search" && !projectName && !fileName && !/\b(?:arquivo|pasta|diretorio|projeto)\b/i.test(lower)) return null;

  const intent = { action, fileName, projectName, searchRoot };
  if ((action === "open_project" && !projectName) || (action === "read_file" && !fileName) || (action === "list_directory" && !projectName && !searchRoot) || (action === "search" && !fileName && !projectName)) {
    return { ...intent, clarification: clarification(action) };
  }
  return intent;
}

export function localResultText(result) {
  const rows = result.results ?? [];
  if (result.status === "ambiguous") {
    return `${result.message}\n\n${rows.map((item) => `- ${item.kind === "directory" ? "Pasta" : "Arquivo"}: ${inlinePath(item.path)}`).join("\n")}`;
  }
  if (result.status === "success" && result.action === "read_file") {
    const limited = result.truncated ? "\n\n[Conteúdo limitado; trecho inicial do arquivo.]" : "";
    const content = result.content ?? "";
    const longestRun = (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    return `Li o arquivo ${inlinePath(result.path)}.\n\n${fence}text\n${content}\n${fence}${limited}`;
  }
  if (result.status === "success" && result.action === "list_directory") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁" : "📄"} ${inlinePath(item.path)}`).join("\n")}` : ""}`;
  }
  if (result.status === "success" && result.action === "search") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁 Pasta" : "📄 Arquivo"}: ${inlinePath(item.path)}`).join("\n")}` : ""}`;
  }
  return result.message;
}

function inlinePath(path) {
  const longestRun = (path.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  return longestRun ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}
