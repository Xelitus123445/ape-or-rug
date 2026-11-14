// Engine purity (math spec 10.1): no floats, no clock, no platform randomness,
// no I/O anywhere under packages/engine/src. This walks the TypeScript syntax
// tree with type information instead of matching text, so comments, strings
// and spelling tricks do not matter.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const FORBIDDEN_GLOBALS = new Set([
  "Math", "Date", "performance", "crypto", "process", "require", "fetch", "setTimeout", "setInterval", "setImmediate",
  "queueMicrotask", "requestAnimationFrame", "parseFloat", "parseInt", "eval", "Function", "globalThis", "window", "self",
  "global", "navigator", "document", "WebSocket", "XMLHttpRequest", "Atomics", "SharedArrayBuffer", "Float32Array",
  "Float64Array", "Float16Array", "Intl", "console", "localStorage", "sessionStorage", "Worker", "Buffer", "Infinity", "NaN",
]);
const FORBIDDEN_MEMBERS = new Set(["toFixed", "toPrecision", "toExponential", "toLocaleString", "random", "now"]);
const ALLOWED_NUMBER_STATICS = new Set(["isInteger", "isSafeInteger"]);
const INTEGER_LITERAL = /^(?:\d[\d_]*|0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+)$/;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  strict: true,
  allowImportingTsExtensions: true,
  noEmit: true,
  skipLibCheck: true,
  types: [],
};

function check(program: ts.Program, files: readonly string[]): string[] {
  const checker = program.getTypeChecker();
  const found: string[] = [];
  const isBigInt = (node: ts.Expression): boolean => {
    const type = checker.getTypeAtLocation(node);
    const parts = type.isUnion() ? type.types : [type];
    return parts.every((t) => (t.flags & ts.TypeFlags.BigIntLike) !== 0);
  };
  for (const file of files) {
    const source = program.getSourceFile(file);
    if (source === undefined) throw new Error(`purity: cannot read ${file}`);
    const report = (node: ts.Node, what: string): void => {
      const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
      found.push(`${source.fileName.split(/[\\/]/).pop()}:${line + 1} ${what}`);
    };
    const visit = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier !== undefined) {
        const spec = (node.moduleSpecifier as ts.StringLiteral).text;
        if (!spec.startsWith("./")) report(node, `import of "${spec}" (only files of the engine itself)`);
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) report(node, "dynamic import");
      if (ts.isNumericLiteral(node) && !INTEGER_LITERAL.test(node.getText(source))) report(node, `non-integer literal ${node.getText(source)}`);
      if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
        const parent = node.parent;
        const isMemberName = (ts.isPropertyAccessExpression(parent) && parent.name === node) || (ts.isPropertyAssignment(parent) && parent.name === node);
        if (!isMemberName) report(node, `use of ${node.text}`);
      }
      if (ts.isPropertyAccessExpression(node)) {
        if (FORBIDDEN_MEMBERS.has(node.name.text)) report(node, `call of .${node.name.text}`);
        if (ts.isIdentifier(node.expression) && node.expression.text === "Number" && !ALLOWED_NUMBER_STATICS.has(node.name.text)) {
          report(node, `Number.${node.name.text}`);
        }
      }
      if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression) && FORBIDDEN_MEMBERS.has(node.argumentExpression.text)) {
        report(node, `call of ["${node.argumentExpression.text}"]`);
      }
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number") {
        const arg = node.arguments[0];
        if (node.arguments.length !== 1 || arg === undefined || !isBigInt(arg)) report(node, "Number(...) of something that is not a bigint");
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Number") report(node, "new Number");
      if (ts.isBinaryExpression(node)) {
        const op = node.operatorToken.kind;
        const divides =
          op === ts.SyntaxKind.SlashToken || op === ts.SyntaxKind.SlashEqualsToken || op === ts.SyntaxKind.AsteriskAsteriskToken || op === ts.SyntaxKind.AsteriskAsteriskEqualsToken;
        if (divides && !(isBigInt(node.left) && isBigInt(node.right))) report(node, `"${node.operatorToken.getText(source)}" on values that are not both bigint`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return found;
}

/** Runs the same check on a snippet held in memory. */
function checkSnippet(code: string): string[] {
  const name = "/virtual/snippet.ts";
  const host = ts.createCompilerHost(OPTIONS);
  const original = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) =>
    fileName === name ? ts.createSourceFile(name, code, languageVersion, true) : original(fileName, languageVersion, ...rest);
  host.fileExists = ((exists) => (f: string) => f === name || exists(f))(host.fileExists.bind(host));
  host.readFile = ((read) => (f: string) => (f === name ? code : read(f)))(host.readFile.bind(host));
  return check(ts.createProgram([name], OPTIONS, host), [name]);
}

describe("engine purity (10.1)", () => {
  it("finds nothing impure in packages/engine/src", () => {
    const dir = fileURLToPath(new URL("../src/", import.meta.url));
    const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f));
    expect(files.length).toBeGreaterThanOrEqual(7);
    const program = ts.createProgram(files, OPTIONS);
    expect(check(program, files)).toEqual([]);
  });

  it("catches every kind of impurity it is meant to catch", () => {
    const impure = [
      "export const a = Math.random();",
      "export const a = Date.now();",
      "export const a = new Date();",
      "export const a = performance.now();",
      "export const a = (price: number) => price / 3;",
      "export const a = 0.5;",
      "export const a = .5;",
      "export const a = 5.;",
      "export const a = 1e9;",
      "export const a = (x: bigint, y: bigint) => Number(x) / Number(y);",
      "export const a = 10 ** -9;",
      "export const a = new Float64Array(4);",
      'export const a = (globalThis as Record<string, unknown>)["Ma" + "th"];',
      "import { readFileSync } from 'node:fs'; export const a = readFileSync;",
      'export const a = async () => await import("node:fs");',
      'import * as fs from "fs"; export const a = fs;',
      "export const a = (1234).toLocaleString();",
      'export const a = parseInt("12") / 100;',
      'export const a = new WebSocket("ws://x");',
      'export const a = eval("1");',
      'export const a = new Function("return 1");',
      "export const a = navigator.userAgent;",
      "export const a = Atomics;",
      'export const a = "//"; export const b = Math.random();',
      'export const a = "/*"; export const b = Math.random(); export const c = "*/";',
      "export const a = (x: number) => Number(x);",
      'export const a = Number("1.5");',
      "export const a = (x: number) => x.toFixed(2);",
      'export const a = (x: number) => (x as unknown as Record<string, () => string>)["toFixed"]();',
      "export const a = Number.MAX_VALUE;",
      "export const a = (x: number, y: bigint) => x / Number(y);",
      "export const a = setTimeout;",
      "export const a = crypto.getRandomValues(new Uint8Array(4));",
      "export const a = Infinity;",
    ];
    for (const code of impure) expect(checkSnippet(code), code).not.toEqual([]);
  });

  it("accepts the integer arithmetic the engine actually uses", () => {
    const pure = [
      "export const a = (x: bigint, y: bigint) => (x * 1_000_000_000n) / y;",
      "export const a = (w: number) => ((w >>> 7) | (w << 25)) ^ (w >>> 3);",
      "export const a = (i: number) => (i * 8 + 2) % 3;",
      "export const a = (h: bigint) => Number(h);",
      "export const a = (x: unknown) => typeof x === 'number' && Number.isInteger(x);",
      "export const a = /^[A-Za-z0-9_-]{1,48}$/; // 1.5 Math.random() in a comment",
      'export const a = "Math.random() / 2.5 in a string";',
      "export const a = 0x428a2f98 | 0;",
    ];
    for (const code of pure) expect(checkSnippet(code), code).toEqual([]);
  });
});
