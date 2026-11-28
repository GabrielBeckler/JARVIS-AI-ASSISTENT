import { createElement } from "react";
import { localResultText } from "./localTools.js";
import { MarkdownMessage } from "./MarkdownMessage.js";

const openHint = "Ctrl + clique direito para abrir";

export function LocalResultPath({ entry, onOpen }) {
  const activate = () => onOpen(entry);
  return createElement("button", {
    type: "button",
    className: "local-result-path",
    title: `${openHint}. No teclado, use Enter ou Espaço.`,
    "aria-label": `Abrir ${entry.path}. ${openHint}.`,
    onClick: activate,
    onContextMenu: (event) => {
      if (!event.ctrlKey || event.button !== 2) return;
      event.preventDefault();
      activate();
    },
  }, createElement("code", null, entry.path));
}

export function LocalToolMessage({ result, onOpen, onChoose, choosingDisabled }) {
  const isRead = result.action === "read_file" && result.status === "success";
  const root = result.action === "list_directory" && result.status === "success" ? result.path : null;
  const rootIndex = root ? result.message.indexOf(root) : -1;
  let summary = isRead ? "Li o arquivo:" : result.message;
  if (root && rootIndex >= 0) {
    summary = [
      result.message.slice(0, rootIndex),
      createElement(LocalResultPath, { key: "root", entry: { path: root, kind: "directory" }, onOpen }),
      result.message.slice(rootIndex + root.length),
    ];
  }
  return createElement("div", null,
    createElement("p", null, summary),
    result.results.length > 0 && createElement("ul", { className: "local-result-list" },
      result.results.map((entry) => createElement("li", { key: entry.path },
        createElement("span", null, entry.kind === "directory" ? "Pasta: " : "Arquivo: "),
        createElement(LocalResultPath, { entry, onOpen }),
        onChoose && createElement("button", {
          type: "button",
          className: "local-result-select",
          disabled: choosingDisabled,
          "aria-label": `Selecionar ${entry.path} para continuar o pedido`,
          onClick: () => onChoose(entry),
        }, "Selecionar"),
      )),
    ),
    isRead && createElement(MarkdownMessage, { content: localResultText(result, false) }),
  );
}
