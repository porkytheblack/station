import test from "node:test";
import assert from "node:assert/strict";
import { validateBrowserCommand } from "../src/commands.js";
import { BunBrowserAdapter } from "../src/bun.js";
test("richer browser commands validate nested targets and bounded pointer/dialog/inspection input", () => {
  for (const value of [
    { op: "click", target: { by: "role", role: "not-a-role" } },
    { op: "click", selector: "button", target: { by: "text", value: "Apply" } },
    { op: "fill", value: "x", target: { by: "label", value: "Name", frame: Array(9).fill("iframe") } },
    { op: "click", target: { by: "testId", value: "x", nth: -1 } },
    { op: "click", target: { by: "testId", value: "x", unknown: true } },
    { op: "mouseClick", x: -1, y: 0 }, { op: "mouseClick", x: 1, y: Infinity },
    { op: "dragCoordinates", from: { x: 1, y: 1, extra: true }, to: { x: 2, y: 2 } },
    { op: "inspect", maxElements: 501 }, { op: "accessibility", depth: 21 },
    { op: "dialog", action: "accept", expiresInMs: 30001 }, { op: "dialog", action: "dismiss", promptText: "forbidden" },
    { op: "diagnostics", consoleText: "yes" }, { op: "traceStart", secret: true },
  ]) assert.throws(() => validateBrowserCommand(value), { code: "invalid_input" });
  const input = { op: "click", target: { by: "text", value: "Apply", frame: ["iframe"], nth: 0 } };
  const result = validateBrowserCommand(input); input.target.frame.push("other");
  assert.equal((result as typeof input).target.frame.length, 1);
  const bun = new BunBrowserAdapter();
  for (const key of ["pointer", "locators", "inspection", "dialogs", "diagnostics", "tracing"] as const) assert.equal(bun.capabilities[key], false);
});
