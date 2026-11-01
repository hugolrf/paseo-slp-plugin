import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = fileURLToPath(new URL("../plugin/client/", import.meta.url));
const visibleProps = new Set(["title", "subtitle", "label", "hint", "placeholder", "accessibilityLabel", "accessibilityHint"]);
const presentationProperties = new Set(["description", "detail", "error", "hint", "label", "message", "placeholder", "subtitle", "text", "title", "why"]);
const presentationCalls = new Set(["setError", "setNotice"]);
const englishWords = /\b(?:active|all|and|are|as|assignment|assignments|at|awaiting|before|binding|cannot|catalog|change|check|choose|close|connection|could|counts|current|details|does|draft|error|failed|feature|filter|for|from|has|have|history|inspection|is|it|key|later|loading|measured|membership|must|no|not|observation|of|on|only|open|or|owner|please|proof|provider|queue|read|recorded|records|reload|required|review|runtime|save|saved|select|selected|settings|should|starter|task|tasks|the|this|to|unavailable|unsaved|use|was|when|with|you|your)\b/iu;
const portugueseWords = /\b(?:aguardando|alterações|aplicação|assento|configurações|diretório|estado|leitura|lendo|nenhum|rascunho|salvo|verificação)\b/iu;
export const TECHNICAL_UI_LITERALS = new Set([
  "/usr/bin/node",
  "avoidFor",
  "case",
  "catalog…",
  "handback=",
  "handling=",
  "peer-coding",
  "suitableFor",
  "uuid",
  "SLP",
  "{}",
  "): brief=",
  "/absolute/path/to/",
  "/absolute/path/to/paseo-home",
  "all",
  "different-model-provider",
  "error",
  "on",
  "restore-before",
  "not-established-by-this-rpc",
  "connection",
  "draft",
  "key",
  "select",
  "tasks",
  "work:change domain:software",
]);

function readCatalog(name) {
  const path = new URL("../plugin/client/pt-br.ts", import.meta.url);
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path.pathname, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const values = {};
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === name && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteral(property.name) || !ts.isStringLiteral(property.initializer)) continue;
        const key = JSON.parse(property.name.getText(tree));
        const value = JSON.parse(property.initializer.getText(tree));
        values[key] = value;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return values;
}

export const catalog = () => readCatalog("PT_BR_UI");
export const dynamicCatalog = () => readCatalog("PT_BR_DYNAMIC_FRAGMENTS");

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : /\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

export function visibleStrings() {
  const found = new Set();
  for (const path of files(root)) {
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if (ts.isJsxText(node)) {
        const value = node.text.replace(/\s+/gu, " ").trim();
        if (/[A-Za-zÀ-ÿ]{3}/u.test(value)) found.add(value);
      }
      if (ts.isJsxAttribute(node) && visibleProps.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
        found.add(node.initializer.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...found].sort();
}

function literalText(node) {
  if (!node) return [];
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [node.text];
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map(span => span.literal.text)].filter(Boolean);
  return [];
}

export function dynamicPresentationStrings() {
  const found = new Set();
  for (const path of files(root)) {
    const source = readFileSync(path, "utf8");
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const addTree = node => {
      for (const value of literalText(node)) {
        const normalized = value.replace(/\s+/gu, " ").trim();
        if (/[A-Za-zÀ-ÿ]{2}/u.test(normalized)) found.add(normalized);
      }
      ts.forEachChild(node, addTree);
    };
    const visit = node => {
      if (ts.isJsxExpression(node) && node.expression) addTree(node.expression);
      if (ts.isPropertyAssignment(node)) {
        const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : "";
        if (presentationProperties.has(name)) addTree(node.initializer);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && presentationCalls.has(node.expression.text)) {
        for (const argument of node.arguments) addTree(argument);
      }
      if (ts.isNewExpression(node) && node.expression.getText(tree) === "Error") {
        for (const argument of node.arguments ?? []) addTree(argument);
      }
      if (ts.isReturnStatement(node) && node.expression && /(?:manager-state|supervision-form|runtime-overview|workflow-panel)\.(?:ts|tsx)$/u.test(path)) {
        addTree(node.expression);
      }
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && /(?:LABEL|MESSAGE|NOTICE|SUBTITLE|TITLE|HINT)$/iu.test(node.name.text)) {
        addTree(node.initializer);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return [...found].sort();
}

export function untranslatedDynamicEnglishStrings() {
  const translations = catalog();
  const fragments = dynamicCatalog();
  const normalizedFragments = new Set(Object.keys(fragments).map(value => value.replace(/\s+/gu, " ").trim()));
  return dynamicPresentationStrings().filter(value => englishWords.test(value) && !portugueseWords.test(value) && translations[value] === undefined && !normalizedFragments.has(value) && !TECHNICAL_UI_LITERALS.has(value));
}

export function untranslatedVisibleStrings() {
  const translations = catalog();
  return visibleStrings().filter(value => englishWords.test(value) && !portugueseWords.test(value) && translations[value] === undefined && !TECHNICAL_UI_LITERALS.has(value));
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const missing = untranslatedVisibleStrings();
  const dynamic = untranslatedDynamicEnglishStrings();
  console.log(JSON.stringify({ visible: visibleStrings().length, translated: visibleStrings().length - missing.length, untranslated: missing.length, strings: missing, dynamicAudited: dynamicPresentationStrings().length, dynamicUntranslated: dynamic.length, dynamicStrings: dynamic }, null, 2));
  if (process.argv.includes("--check") && (missing.length > 0 || dynamic.length > 0)) process.exitCode = 1;
}
