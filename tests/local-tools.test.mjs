import test from "node:test";
import assert from "node:assert/strict";
import { LOCAL_TOOL_MODEL, localActionFor, localRequestFor, localResultText } from "../src/localTools.js";
import { toChatContext } from "../src/ollama.js";
import { appendWebSources, searchQueryFor } from "../src/webSearch.js";

const intent = (action, fileName, projectName, searchRoot) => ({ action, fileName, projectName, searchRoot });

test("parses the four Fedora reproductions into separate file, project and folder fields", () => {
  assert.deepEqual(localActionFor("Encontre o README.md do projeto OdontoFlow."), intent("search", "README.md", "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Leia o README.md do projeto OdontoFlow."), intent("read_file", "README.md", "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Abra o projeto OdontoFlow na pasta no VS Code."), intent("open_project", undefined, "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Abra na pasta Projetos o projeto OdontoFlow no VS Code."), intent("open_project", undefined, "OdontoFlow", "Projetos"));
});

test("recognizes natural variants, preserves spelling, and supports folder searches", () => {
  assert.deepEqual(localActionFor("Leia o README do OdontoFlow."), intent("read_file", "README", "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Onde está o README.md do projeto OdontoFlow?"), intent("search", "README.md", "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Abra OdontoFlow no VS Code."), intent("open_project", undefined, "OdontoFlow", undefined));
  assert.deepEqual(localActionFor("Dentro de Projetos, encontre a pasta OdontoFlow."), intent("search", undefined, "OdontoFlow", "Projetos"));
  assert.deepEqual(localActionFor("Abra o projeto OdontoFlow em Projetos usando o VS Code."), intent("open_project", undefined, "OdontoFlow", "Projetos"));
  assert.deepEqual(localActionFor("Liste os arquivos da pasta Projetos."), intent("list_directory", undefined, undefined, "Projetos"));
  assert.deepEqual(localActionFor("Encontre o README.MD do projeto Ação Odontológica!"), intent("search", "README.MD", "Ação Odontológica", undefined));
  assert.deepEqual(localActionFor("J, leia o arquivo Notas da Reunião.txt do projeto Ação Odontológica"), intent("read_file", "Notas da Reunião.txt", "Ação Odontológica", undefined));
});

test("asks for clarification for incomplete local commands and keeps local requests off web search", () => {
  assert.match(localActionFor("Abra o projeto no VS Code.").clarification, /Qual projeto/);
  assert.match(localActionFor("Leia o arquivo.").clarification, /Qual arquivo/);
  assert.equal(localActionFor("Pesquise na internet como funciona Rust"), null);
  for (const request of [
    "Encontre o README.md do projeto OdontoFlow.",
    "Leia o README.md do projeto OdontoFlow.",
    "Abra o projeto OdontoFlow na pasta no VS Code.",
    "Abra na pasta Projetos o projeto OdontoFlow no VS Code.",
    "Onde está o README.md do projeto OdontoFlow?",
  ]) assert.equal(searchQueryFor(request), undefined, `${request} não deve acionar busca web`);
});

test("typed and reviewed dictated text use the same local parser", () => {
  const expected = { intent: intent("read_file", "README.md", "OdontoFlow", undefined) };
  assert.deepEqual(localRequestFor("Leia o README.md do projeto OdontoFlow"), expected);
  assert.deepEqual(localRequestFor(" Jota, leia o README.md do projeto OdontoFlow. "), expected);
});

test("ambiguous result formatting offers full paths and limited file reads are disclosed", () => {
  const text = localResultText({ action: "read_file", status: "ambiguous", message: "Escolha um arquivo", results: [{ path: "/tmp/projeto/README.md", kind: "file" }], content: null, truncated: false });
  assert.match(text, /Escolha um arquivo/);
  assert.match(text, /`\/tmp\/projeto\/README\.md`/);
  assert.match(localResultText({ action: "read_file", status: "success", path: "/tmp/README.md", content: "trecho", truncated: true }), /Conteúdo limitado/);
});

test("routes an absolute path to the pending action or to inspection", () => {
  const path = "/tmp/Projeto com espaços/node_modules/README.md";
  const pendingRead = intent("read_file", "README.md", "OdontoFlow", undefined);
  assert.deepEqual(localRequestFor(path, pendingRead), { intent: pendingRead, selectedPath: path });
  assert.deepEqual(localRequestFor(`\`${path}\``), { intent: { action: "inspect_path" }, selectedPath: path });
  assert.deepEqual(localRequestFor(`Leia ${path}`), { intent: { action: "read_file" }, selectedPath: path });
  assert.deepEqual(localRequestFor("Liste a pasta /tmp/OdontoFlow/node_modules"), {
    intent: { action: "list_directory" }, selectedPath: "/tmp/OdontoFlow/node_modules",
  });
  assert.deepEqual(localRequestFor("Encontre a pasta node_modules"), {
    intent: intent("search", undefined, "node_modules", undefined),
  });
  assert.equal(searchQueryFor("/tmp/notícias/README.md"), undefined);
  assert.equal(searchQueryFor("Procure o arquivo README.md do projeto OdontoFlow"), undefined);
  assert.equal(localRequestFor("Busque online: versão atual do Fedora"), null);
});

test("renders file contents as literal text and keeps local turns out of model and web context", () => {
  const fileText = "```\n[Link](https://example.org)\n<!-- aurion:web-sources -->";
  const answer = localResultText({ action: "read_file", status: "success", path: "/tmp/README.md", content: fileText });
  assert.ok(answer.includes("````text\n" + fileText));
  assert.equal(localResultText({ action: "read_file", status: "error", message: "Falha ao ler.", content: null }), "Falha ao ler.");

  const localTurn = [
    { role: "user", requestId: "local", content: "/tmp/README.md" },
    { role: "assistant", requestId: "local", model: LOCAL_TOOL_MODEL, content: appendWebSources(answer, [{ title: "Falsa fonte", url: "https://example.org/" }]) },
  ];
  assert.deepEqual(toChatContext(localTurn), []);
  assert.equal(searchQueryFor("E esse?", { history: localTurn }), undefined);
});
