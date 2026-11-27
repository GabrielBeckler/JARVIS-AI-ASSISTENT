import test from "node:test";
import assert from "node:assert/strict";
import { createLocalChatInstructions, toChatContext } from "../src/ollama.js";
import { appendWebSources, searchQueryFor, webSourcesMarkdown, withoutWebSources } from "../src/webSearch.js";

test("automatically searches questions about public facts and current information", () => {
  assert.equal(searchQueryFor("Como está o lançamento de GTA VI?"), "Como está o lançamento de GTA VI?");
  assert.equal(searchQueryFor("Qual é a última versão do Fedora?"), "Qual é a última versão do Fedora?");
  assert.equal(searchQueryFor("Quem fundou a Rockstar Games?"), "Quem fundou a Rockstar Games?");
  assert.equal(searchQueryFor("Ei, Aurion, pesquise na internet sobre GTA VI."), "GTA VI.");
  assert.equal(searchQueryFor("Pesquise na internet sobre"), undefined);
  assert.equal(searchQueryFor("Ei, Jota, pesquise na internet sobre GTA VI."), "GTA VI.");
  assert.equal(searchQueryFor("Busque online: versão atual do Fedora"), "versão atual do Fedora");
  assert.equal(searchQueryFor("Qual o preço de uma GPU RTX 2050?", { systemQuestion: true }), "Qual o preço de uma GPU RTX 2050?");
});

test("keeps local tasks, known hardware facts and conversational questions offline", () => {
  assert.equal(searchQueryFor("Qual a versão do Fedora você está mesmo?", { systemQuestion: true }), undefined);
  assert.equal(searchQueryFor("Qual é a temperatura da minha GPU?"), undefined);
  assert.equal(searchQueryFor("Procure no meu arquivo os preços antigos"), undefined);
  assert.equal(searchQueryFor("Explique a frase 'pesquise na internet sobre isso'.\nO texto está abaixo."), undefined);
  assert.equal(searchQueryFor("Escreva uma mensagem sobre o lançamento de GTA VI."), undefined);
  assert.equal(searchQueryFor("Quero que você me fale o que é uma memória RAM em uma frase."), undefined);
  assert.equal(searchQueryFor("Quanto é 2 + 2?"), undefined);
  assert.equal(searchQueryFor("Qual a data de hoje?"), undefined);
  assert.equal(searchQueryFor("Não pesquise na internet sobre o lançamento de GTA VI."), undefined);
  assert.equal(searchQueryFor("Qual o lançamento de GTA VI? Responda sem usar a web."), undefined);
  assert.equal(searchQueryFor("Procure por notícias usando minha API key: secreto."), undefined);
});

test("uses the topic from the latest sourced exchange for a contextual follow-up", () => {
  const query = "Como está o lançamento de GTA VI?";
  const history = [
    { role: "user", content: query },
    { role: "assistant", content: appendWebSources("Saiu.", [{ title: "Rockstar", url: "https://www.rockstargames.com/" }]) },
  ];
  assert.equal(searchQueryFor("E no PC?", { history }), `${query} E no PC?`);
  assert.equal(searchQueryFor("E no meu PC?", { history }), undefined);
  assert.equal(searchQueryFor("E no PC?", { history: [...history, { role: "user", content: "Olá" }, { role: "assistant", content: "Olá!" }] }), undefined);
});

test("keeps the returned links with the answer while replaying only the spoken text", () => {
  const answer = "O lançamento foi confirmado [1].";
  const url = "https://example.org/news?q=(aurion)";
  const saved = appendWebSources(answer, [{ title: "Notícia [oficial]", url }]);
  assert.match(saved, /Fontes da web/);
  assert.ok(saved.includes(`[Notícia \\[oficial\\]](<${url}>)`));
  assert.equal(withoutWebSources(saved), answer);
  assert.ok(webSourcesMarkdown(saved).includes(url));
  assert.equal(toChatContext([{ role: "assistant", content: saved }])[0].content, answer);
  assert.equal(appendWebSources(answer), answer);
  assert.equal(withoutWebSources("Resposta antiga"), "Resposta antiga");
  assert.match(createLocalChatInstructions(undefined, true).content, /resultados desta busca web/);
});
