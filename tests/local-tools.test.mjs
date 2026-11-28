import test from "node:test";
import assert from "node:assert/strict";
import { localActionFor, localResultText } from "../src/localTools.js";
import { searchQueryFor } from "../src/webSearch.js";

test("recognizes local file, listing and VS Code requests", () => {
  assert.deepEqual(localActionFor("Encontre o README do OdontoFlow."), { action: "search", query: "readme do odontoflow" });
  assert.deepEqual(localActionFor("Liste os arquivos da pasta do meu projeto OdontoFlow"), { action: "list_directory", query: "do meu projeto odontoflow" });
  assert.deepEqual(localActionFor("Leia o arquivo README.md do projeto OdontoFlow"), { action: "read_file", query: "readme.md do projeto odontoflow" });
  assert.deepEqual(localActionFor("Abra o projeto OdontoFlow no VS Code"), { action: "open_project", query: "odontoflow" });
  assert.deepEqual(localActionFor("Procure o arquivo anotações.txt no meu computador"), { action: "search", query: "anotacoes.txt" });
  assert.equal(localActionFor("Pesquise na internet como funciona Rust"), null);
  for (const request of ["Encontre o README do OdontoFlow", "Liste os arquivos da pasta do projeto OdontoFlow", "Leia o arquivo README.md do projeto OdontoFlow", "Abra o projeto OdontoFlow no VS Code", "Procure o arquivo anotacoes.txt no meu computador"]) {
    assert.equal(searchQueryFor(request), undefined, `${request} não deve ir para a pesquisa web`);
  }
});

test("ambiguous results preserve candidate paths and bounded file content is disclosed", () => {
  const text = localResultText({ action: "read_file", status: "ambiguous", message: "Escolha um arquivo", results: [{ path: "/tmp/a", kind: "file" }], content: null, truncated: false });
  assert.match(text, /Escolha um arquivo/);
  assert.match(text, /`\/tmp\/a`/);
  assert.match(localResultText({ action: "read_file", status: "success", message: "", results: [], content: "trecho", truncated: true }), /Conteúdo limitado/);
});
