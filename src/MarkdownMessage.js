import { createElement } from "react";
import ReactMarkdown from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";

export function safeMarkdownUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return ["http:", "https:", "mailto:"].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function SafeLink({ href, children }) {
  const safeHref = safeMarkdownUrl(href);
  if (!safeHref) return createElement("span", { className: "markdown-link-blocked" }, children);
  return createElement("a", {
    href: safeHref,
    target: "_blank",
    rel: "noopener noreferrer",
    onClick: (event) => {
      event.preventDefault();
      void openUrl(safeHref).catch(() => undefined);
    },
  }, children);
}

const components = {
  a: SafeLink,
  img: () => null,
  pre: ({ children }) => createElement("pre", { tabIndex: 0, "aria-label": "Bloco de código" }, children),
};

export function MarkdownMessage({ content }) {
  return createElement(ReactMarkdown, {
    children: content,
    skipHtml: true,
    urlTransform: safeMarkdownUrl,
    components,
  });
}
