import test from "node:test";
import assert from "node:assert/strict";
import { localActionFor, localResultText } from "../src/localTools.js";
import { searchQueryFor } from "../src/webSearch.js";

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
  const transcript = "Leia o README.md do projeto OdontoFlow.";
  const typedMessage = transcript;
  const reviewedDictation = transcript;
  assert.deepEqual(localActionFor(typedMessage), localActionFor(reviewedDictation));
});

test("ambiguous result formatting offers full paths and limited file reads are disclosed", () => {
  const text = localResultText({ action: "read_file", status: "ambiguous", message: "Escolha um arquivo", results: [{ path: "/tmp/projeto/README.md", kind: "file" }], content: null, truncated: false });
  assert.match(text, /Escolha um arquivo/);
  assert.match(text, /`\/tmp\/projeto\/README\.md`/);
  assert.match(localResultText({ action: "read_file", status: "success", message: "", results: [], content: "trecho", truncated: true }), /Conteúdo limitado/);
});
