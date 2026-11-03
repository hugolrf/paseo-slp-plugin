import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalog, dynamicCatalog, dynamicPresentationStrings, TECHNICAL_UI_LITERALS, untranslatedDynamicEnglishStrings, untranslatedVisibleStrings, visibleStrings } from "../scripts/audit-plugin-localization.mjs";

test("traduz rótulos, estados e ações visíveis sem alterar identificadores", () => {
  const translations = catalog();
  assert.equal(translations.Overview, "Visão geral");
  assert.equal(translations["Communication language"], "Idioma de comunicação");
  assert.equal(translations["Save changes"], "Salvar alterações");
  assert.equal(translations["Routing / Jev"], "Roteamento / Jev");
  const navigation = readFileSync(new URL("../plugin/client/manager-navigation.ts", import.meta.url), "utf8");
  for (const id of ["overview", "profiles", "pool", "jev", "supervision", "language", "maintenance"]) assert.match(navigation, new RegExp(`id: "${id}"`));
});

test("catálogo usa traduções exatas e a auditoria inventaria toda pendência visível", () => {
  const translations = catalog();
  assert.ok(Object.keys(translations).length >= 200);
  const technical = new Set(["Host", "Jev", "Node", "Payload", "Runtime"]);
  assert.ok(Object.entries(translations).every(([source, translated]) => source !== translated || technical.has(source)));
  assert.ok(visibleStrings().length > 200);
  assert.deepEqual(untranslatedVisibleStrings(), []);
  assert.ok(dynamicPresentationStrings().length > 200);
  assert.ok(Object.keys(dynamicCatalog()).length > 100);
  assert.deepEqual(untranslatedDynamicEnglishStrings(), []);
  assert.equal(TECHNICAL_UI_LITERALS.size, 26);
});


// Carrega o ptBR() real: transpila pt-br.ts e substitui react/react-native por stubs.
async function loadPtBR() {
  const { createRequire } = await import("node:module");
  const ts = (await import("typescript")).default;
  const source = readFileSync(new URL("../plugin/client/pt-br.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } });
  const module = { exports: {} };
  const stubs = { react: { createElement: () => null }, "react-native": { Text: () => null } };
  new Function("exports", "require", "module", outputText)(module.exports, name => stubs[name], module);
  return module.exports.ptBR;
}

test("mensagens de erro do pool de peers vindas do servidor são traduzidas na renderização com sufixo preservado", async () => {
  const ptBR = await loadPtBR();
  assert.equal(ptBR("peer pool unreadable: EACCES: permission denied, open '/x/pool.json'"), "Pool de Peers ilegível: EACCES: permission denied, open '/x/pool.json'");
  assert.equal(ptBR("peer pool failed schema validation: Required"), "O pool de Peers falhou na validação do esquema: Required");
  assert.equal(ptBR("peer pool is not valid JSON: Unexpected token } in JSON at position 4"), "O pool de Peers não é um JSON válido: Unexpected token } in JSON at position 4");
  assert.equal(ptBR("peer pool changed since it was read — reload before saving"), "O pool de Peers mudou desde a leitura — recarregue antes de salvar");
  // A detecção CAS em peer-pool.tsx usa a mensagem crua, antes da tradução.
  const card = readFileSync(new URL("../plugin/client/cards/peer-pool.tsx", import.meta.url), "utf8");
  assert.match(card, /message\.includes\("peer pool changed"\)/);
});
