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

