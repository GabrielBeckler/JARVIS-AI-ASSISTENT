import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarkdownMessage, safeMarkdownUrl } from "../src/MarkdownMessage.js";

function render(content) {
  return renderToStaticMarkup(createElement(MarkdownMessage, { content }));
}

test("renders paragraphs, lists, emphasis, inline code, and fenced code", () => {
  const html = render("Primeiro parágrafo.\n\n- item **forte**\n- `código`\n\n```ts\nconst answer = 42\n```");
  assert.match(html, /<p>Primeiro parágrafo\.<\/p>/);
  assert.match(html, /<ul>[\s\S]*<li>item <strong>forte<\/strong><\/li>[\s\S]*<li><code>código<\/code><\/li>[\s\S]*<\/ul>/);
  assert.match(html, /<pre><code class="language-ts">const answer = 42\n<\/code><\/pre>/);
});

test("does not parse raw HTML or create remote image elements", () => {
  const html = render('<img src="https://attacker.test/pixel.png" onerror="alert(1)">\n\n![pixel](https://attacker.test/markdown.png)\n\n<script>alert(1)</script>');
  assert.doesNotMatch(html, /<img\b|<script\b|onerror=/i);
  assert.doesNotMatch(html, /attacker\.test/);
});

test("blocks unsafe and relative links while keeping safe external links inert until clicked", () => {
  const html = render("[seguro](https://example.com/docs) [email](mailto:help@example.com) [script](javascript:alert(1)) [arquivo](file:///etc/passwd) [relativo](/settings)");
  assert.match(html, /href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="mailto:help@example\.com"/);
  assert.equal((html.match(/<a\b/g) ?? []).length, 2);
  assert.match(html, /<span class="markdown-link-blocked">script<\/span>/);
  assert.match(html, /<span class="markdown-link-blocked">arquivo<\/span>/);
  assert.match(html, /<span class="markdown-link-blocked">relativo<\/span>/);
  assert.equal(safeMarkdownUrl("javascript:alert(1)"), undefined);
  assert.equal(safeMarkdownUrl("data:text/html,hi"), undefined);
  assert.equal(safeMarkdownUrl("https://example.com"), "https://example.com/");
});

test("keeps unfinished streaming Markdown readable", () => {
  const html = render("Resposta **parcial\n\n```js\nconst text = 'chegando'");
  assert.match(html, /Resposta \*\*parcial/);
  assert.match(html, /<pre><code class="language-js">const text = &#x27;chegando&#x27;\n<\/code><\/pre>/);
});

test("continues rendering plain-text messages from older conversations", () => {
  assert.equal(render("Resposta antiga sem marcação"), "<p>Resposta antiga sem marcação</p>");
});
