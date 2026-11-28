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

const openKinds = {
  arquivo: "file", documento: "file", item: undefined,
  pasta: "directory", diretorio: "directory", imagem: "image", foto: "image", pdf: "pdf", video: "video",
};
const ordinals = ["primeir", "segund", "terceir", "quart", "quint", "sext", "setim", "oitav", "non", "decim"];
const listAgain = "Faça uma nova busca ou listagem nesta conversa, ou informe o caminho completo.";

function openingRequest(text) {
  const plain = normalize(text);
  if (/^(?:me )?(?:mostre|mostrar|exiba|exibir)\s+(?:esse|este|o)\s+(?:arquivo|item)\s+na\s+pasta[.!?]*$/.test(plain)) {
    return { intent: { action: "reveal_item", targetKind: "file" }, reference: { mode: "recent" } };
  }
  const command = text.match(/^(?:me\s+)?(?:abra|abrir|abre)\s+(?:(?:o|a)\s+)?(.+)$/i);
  if (!command || /\b(?:no|pelo|usando|com)\s+(?:o\s+)?(?:visual studio code|vs\s*code|vscode)[.!?]*$/.test(plain)) return null;
  let target = command[1].trim();
  const directPath = pathFrom(target.replace(/[.!?]$/u, ""));
  if (directPath) return { intent: { action: "open_item" }, selectedPath: directPath };

  const ordinal = normalize(target).match(/^(\w+)\s+(arquivo|item|pasta|diretorio|imagem|foto|pdf|video)[.!?]*$/);
  if (ordinal) {
    const index = ordinals.indexOf(ordinal[1].replace(/[oa]$/, ""));
    if (index >= 0) return {
      intent: { action: "open_item", targetKind: openKinds[ordinal[2]] },
      reference: { mode: "position", index },
    };
  }
  const kind = target.match(/^(arquivo|documento|item|pasta|diret[oó]rio|imagem|foto|pdf|v[ií]deo)(?:\s+|[.!?]*$)/i);
  if (!kind) return null;
  target = target.slice(kind[0].length).trim();
  const targetKind = openKinds[normalize(kind[1])];
  const intent = { action: "open_item", targetKind };
  const path = pathFrom(target.replace(/[.!?]$/u, ""));
  if (path) return { intent, selectedPath: path };

  const scope = target.match(/\s+(?:em|nos?|nas?|dos?|das?|dentro\s+d[aeo])\s+(?:(?:minha\s+)?pasta\s+(?:de\s+)?)?(downloads?|dowloads?)[.!?]*$/i);
  const operand = (scope ? target.slice(0, scope.index) : target.replace(/[.!?]$/u, "")).trim();
  const name = operand.match(/^(?:"(.*)"|'(.*)'|`(.*)`)$/u)?.slice(1).find((value) => value !== undefined) ?? operand;
  if (!name) return { intent: { ...intent, clarification: "Qual item devo abrir? Informe o nome ou o caminho completo." } };
  if (scope) return { intent: { ...intent, downloads: true, fileName: name } };
  return { intent, reference: { mode: "name", name } };
}

export function localRequestFor(input, pendingChoice) {
  const text = input.trim().replace(prefix, "").trim();
  const path = pathFrom(text);
  if (path) {
    return { intent: pendingChoice ?? { action: "inspect_path" }, selectedPath: path };
  }

  const opening = openingRequest(text);
  if (opening) return opening;

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
  const opening = openingRequest(text);
  if (opening) return opening.intent;
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

export function localResultText(result, includePaths = true) {
  const rows = includePaths ? result.results ?? [] : [];
  if (result.status === "ambiguous") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "Pasta" : "Arquivo"}: ${inlinePath(item.path)}`).join("\n")}` : ""}`;
  }
  if (result.status === "success" && result.action === "read_file") {
    const limited = result.truncated ? "\n\n[Conteúdo limitado; trecho inicial do arquivo.]" : "";
    const content = result.content ?? "";
    const longestRun = (content.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
    const fence = "`".repeat(Math.max(3, longestRun + 1));
    const intro = includePaths ? `Li o arquivo ${inlinePath(result.path)}.\n\n` : "";
    return `${intro}${fence}text\n${content}\n${fence}${limited}`;
  }
  if (result.status === "success" && result.action === "list_directory") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁" : "📄"} ${inlinePath(item.path)}`).join("\n")}` : ""}`;
  }
  if (result.status === "success" && result.action === "search") {
    return `${result.message}${rows.length ? `\n\n${rows.map((item) => `- ${item.kind === "directory" ? "📁 Pasta" : "📄 Arquivo"}: ${inlinePath(item.path)}`).join("\n")}` : ""}`;
  }
  if (rows.length && ["open_item", "reveal_item"].includes(result.action)) {
    return `${result.message}\n\n${inlinePath(rows[0].path)}`;
  }
  return result.message;
}

const imageExtensions = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg", "bmp", "tif", "tiff", "avif", "heic"]);
const videoExtensions = new Set(["mp4", "mkv", "webm", "mov", "avi", "mpeg", "mpg", "m4v", "ogv"]);
function entryMatches(entry, kind) {
  if (!kind || kind === entry.kind) return true;
  if (entry.kind !== "file") return false;
  const extension = entry.path.split("/").at(-1).split(".").at(-1).toLowerCase();
  return kind === "pdf" ? extension === "pdf"
    : kind === "image" ? imageExtensions.has(extension)
      : kind === "video" && videoExtensions.has(extension);
}

export function resolveLocalReference(reference, kind, list, recent) {
  const clarify = (message) => ({ message: `${message} ${listAgain}` });
  if (reference.mode === "recent" && recent && entryMatches(recent, kind)) return { entry: recent };
  if (!list) return clarify("Não tenho uma lista local disponível. Resultados anteriores ficam disponíveis até fechar o J.");
  if (list.truncated) return clarify("A última lista local está incompleta.");
  const entries = list.entries.filter((entry) => entryMatches(entry, kind));
  if (reference.mode === "position") {
    return entries[reference.index] ? { entry: entries[reference.index] } : clarify("A posição pedida não consta na última lista local.");
  }
  if (reference.mode === "name") {
    const name = normalize(reference.name);
    const base = (entry) => normalize(entry.path.split("/").at(-1));
    const exact = entries.filter((entry) => base(entry) === name);
    const matches = exact.length ? exact : entries.filter((entry) => base(entry).includes(name));
    if (matches.length === 1) return { entry: matches[0] };
    if (matches.length > 1) return { choices: matches };
    return clarify("Não encontrei esse nome na última lista local.");
  }
  return entries.length === 1 ? { entry: entries[0] } : clarify("Não sei qual arquivo você quer mostrar na pasta.");
}

export function isSameLocalList(list, result) {
  return result.status === "success" && !result.truncated && list.entries.length === result.results.length
    && list.entries.every((entry, index) => entry.path === result.results[index].path && entry.kind === result.results[index].kind);
}

export function latestLocalContext(messages, outputs) {
  let recent;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const output = outputs[messages[index].id];
    if (output?.list) return { list: output.list, recent };
    recent ??= output?.recent;
  }
  return { recent };
}

function inlinePath(path) {
  const longestRun = (path.match(/`+/g) ?? []).reduce((longest, run) => Math.max(longest, run.length), 0);
  const fence = "`".repeat(longestRun + 1);
  return longestRun ? `${fence} ${path} ${fence}` : `${fence}${path}${fence}`;
}
