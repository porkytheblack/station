import assert from "node:assert/strict";
import { test } from "node:test";
import Ajv from "ajv";
import { browserCommandSchema, browserOpenOptionsSchema } from "../src/agent-schema.js";
import { validateBrowserCommand, validateBrowserOpenOptions, type BrowserCommand } from "../src/commands.js";

// Use a real JSON Schema engine so these tests exercise the public contract as
// an agent framework would, independently of Station's hand-written validator.
const ajv = new Ajv({ strict: false, allErrors: true });
const commandSchema = ajv.compile(browserCommandSchema);
const optionsSchema = ajv.compile(browserOpenOptionsSchema);
const target = { by: "role", role: "button", name: "Submit", exact: true, frame: ["iframe"], nth: 0 } as const;
const roleTarget = { ...target, frame: [...target.frame] };
const valid = {
  fill: { op: "fill", target: { by: "label", value: "Name" }, value: "Zoë" },
  select: { op: "select", selector: "select", values: [] },
  check: { op: "check", target: { by: "testId", value: "terms" }, checked: false },
  hover: { op: "hover", selector: "a" }, click: { op: "click", target: roleTarget },
  focus: { op: "focus", target: { by: "text", value: "Welcome" } },
  press: { op: "press", selector: "input", key: "Control+A" },
  scroll: { op: "scroll", x: -10_000_000, y: 0.5 },
  waitFor: { op: "waitFor", selector: "#spinner", state: "detached" },
  content: { op: "content" }, back: { op: "back" }, forward: { op: "forward" },
  reload: { op: "reload" }, pages: { op: "pages" }, traceStart: { op: "traceStart" }, traceStop: { op: "traceStop" },
  newPage: { op: "newPage", url: "https://example.com" }, selectPage: { op: "selectPage", pageId: "page_1" }, closePage: { op: "closePage", pageId: "page-2" },
  upload: { op: "upload", selector: "input[type=file]", files: [{ name: "résumé.txt", mimeType: "text/plain", base64: "aGVsbG8=" }] },
  download: { op: "download", target: roleTarget }, downloadRead: { op: "downloadRead", artifactId: "artifact_1" }, downloadDelete: { op: "downloadDelete", artifactId: "artifact_1" },
  mouseClick: { op: "mouseClick", x: 0.5, y: 100_000, button: "right", clickCount: 2 }, mouseMove: { op: "mouseMove", x: 0, y: 12 },
  drag: { op: "drag", source: { by: "selector", value: "#source" }, destination: roleTarget },
  dragCoordinates: { op: "dragCoordinates", from: { x: 0, y: 0 }, to: { x: 12.5, y: 90 }, steps: 100 },
  inspect: { op: "inspect", target: roleTarget, maxElements: 500, maxTextLength: 4096 },
  accessibility: { op: "accessibility", depth: 20, boxes: false },
  dialog: { op: "dialog", action: "accept", promptText: "", expiresInMs: 30_000 },
  diagnostics: { op: "diagnostics", consoleText: false, clear: true },
} satisfies Record<BrowserCommand["op"], BrowserCommand>;

function agree(input: unknown, expected: boolean, schema = commandSchema, runtime: (input: unknown) => unknown = validateBrowserCommand) {
  let accepted = true;
  try { runtime(input); } catch { accepted = false; }
  assert.equal(accepted, expected, `Runtime: ${JSON.stringify(input).slice(0, 300)}`);
  assert.equal(schema(input), expected, `Schema: ${JSON.stringify(input).slice(0, 300)}\n${ajv.errorsText(schema.errors)}`);
}

test("agent schema covers every command and rejects extra properties and omitted required fields", () => {
  const declared = (browserCommandSchema.oneOf as any[]).map((branch) => branch.properties.op.const).sort();
  assert.deepEqual(declared, Object.keys(valid).sort());
  for (const input of Object.values(valid)) {
    agree(input, true);
    agree({ ...input, accidentalSecret: "must not be accepted" }, false);
    const { op: _op, ...withoutOp } = input;
    agree(withoutOp, false);
  }
  for (const input of [null, [], "click", {}, { op: "evaluate", script: "1" }, { op: "constructor" }]) agree(input, false);
  for (const input of [
    { op: "fill", selector: "input" }, { op: "press", selector: "input" }, { op: "check", selector: "input" },
    { op: "select", selector: "select" }, { op: "upload", selector: "input" }, { op: "mouseMove", x: 0 },
    { op: "drag", source: roleTarget }, { op: "dragCoordinates", from: { x: 0, y: 0 } },
    { op: "dialog" }, { op: "selectPage" }, { op: "downloadRead" },
  ]) agree(input, false);
});

test("locator exclusivity, frame chains, roles, and command boundaries match the runtime", () => {
  for (const input of [
    { op: "click" }, { op: "click", selector: "a", target: roleTarget }, { op: "click", selector: "" },
    { op: "click", target: { by: "role", role: "not-an-aria-role" } },
    { op: "click", target: { ...roleTarget, value: "unexpected" } },
    { op: "click", target: { by: "selector", value: "a", role: "button" } },
    { op: "click", target: { ...roleTarget, frame: Array(9).fill("iframe") } },
    { op: "click", target: { ...roleTarget, frame: [""] } },
    { op: "click", target: { ...roleTarget, nth: 1000 } },
    { op: "click", target: { ...roleTarget, nth: 0.5 } },
    { op: "click", target: { ...roleTarget, exact: "true" } },
    { op: "waitFor", selector: "a", state: "enabled" }, { op: "press", selector: "a", key: "" },
    { op: "mouseClick", x: -1, y: 0 }, { op: "mouseClick", x: 0, y: 0, clickCount: 3 },
    { op: "mouseClick", x: 0, y: 0, button: "back" }, { op: "scroll", x: 10_000_001, y: 0 },
    { op: "dragCoordinates", from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0 } },
    { op: "inspect", maxElements: 0 }, { op: "inspect", maxTextLength: 4097 },
    { op: "accessibility", depth: 21 }, { op: "accessibility", boxes: 1 },
    { op: "dialog", action: "dismiss", promptText: "" }, { op: "dialog", action: "accept", expiresInMs: 30_001 },
    { op: "diagnostics", consoleText: "false" }, { op: "newPage", url: null },
    { op: "select", selector: "a", values: Array(101).fill("x") },
    { op: "selectPage", pageId: "with spaces" }, { op: "downloadRead", artifactId: "../artifact" },
  ]) agree(input, false);
  agree({ op: "click", target: { ...roleTarget, nth: 999, frame: Array(8).fill("iframe") } }, true);
  agree({ op: "fill", selector: "input", value: "x".repeat(65536) }, true);
  agree({ op: "fill", selector: "input", value: "x".repeat(65537) }, false);
});

test("upload schema checks canonical base64 and safe names including padding edge cases", () => {
  const file = (base64: string, name = "file.txt") => ({ op: "upload", selector: "input", files: [{ name, mimeType: "", base64 }] });
  for (const payload of ["", "Zg==", "Zm8=", "Zm9v", "AA==", "/w==", "//8=", "////"]) agree(file(payload), true);
  for (const payload of ["Zg", "Zg===", "Zh==", "Zm9=", "====", "Zg==\n", " Zg==", "AA=A"]) agree(file(payload), false);
  for (const name of [".", "..", "a/b", "a\\b", "a\0b", ""]) agree(file("", name), false);
  // Filenames may contain newlines; only traversal names/separators/NUL are forbidden.
  agree(file("", ".\n"), true);
  agree({ op: "upload", selector: "input", files: [] }, true);
  agree({ op: "upload", selector: "input", files: Array(17).fill({ name: "a", mimeType: "", base64: "" }) }, false);
});

test("open schema matches viewport, identifier, and idle limit validation", () => {
  for (const input of [{}, { profileId: "profile-1", viewport: { width: 1, height: 4096 }, idleTimeoutMs: 100 }, { idleTimeoutMs: 86_400_000 }]) agree(input, true, optionsSchema, validateBrowserOpenOptions);
  for (const input of [null, [], { surprise: true }, { profileId: "../profile" }, { profileId: "" }, { viewport: { width: 1 } }, { viewport: { width: 1, height: 1, scale: 2 } }, { viewport: { width: 1.5, height: 1 } }, { viewport: { width: 0, height: 1 } }, { viewport: { width: 4097, height: 1 } }, { idleTimeoutMs: 99 }, { idleTimeoutMs: 86_400_001 }]) agree(input, false, optionsSchema, validateBrowserOpenOptions);
});

test("portable schema documents runtime-only byte limits rather than claiming full validation", () => {
  const multibyte = { op: "fill", selector: "input", value: "😀".repeat(20_000) };
  assert.equal(commandSchema(multibyte), true);
  assert.throws(() => validateBrowserCommand(multibyte));
  const bytes = Buffer.alloc(3 * 1024 * 1024).toString("base64");
  const aggregate = { op: "upload", selector: "input", files: [{ name: "one", mimeType: "", base64: bytes }, { name: "two", mimeType: "", base64: bytes }] };
  assert.equal(commandSchema(aggregate), true);
  assert.throws(() => validateBrowserCommand(aggregate));
  assert.match(JSON.stringify(browserCommandSchema), /UTF-8 bytes/);
  assert.match(JSON.stringify(browserCommandSchema), /4 MiB/);
});
