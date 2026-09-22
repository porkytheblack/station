/**
 * Portable JSON Schema for agent tool inputs (Draft 7 or later).
 *
 * Runtime validation remains authoritative: JSON Schema maxLength counts Unicode
 * characters, whereas Station limits UTF-8 bytes. The combined decoded upload
 * size also requires runtime validation. Both limits are described at the field.
 * These schemas intentionally use no custom keywords or external references.
 */
type Schema = Record<string, unknown>;
const object = (properties: Record<string, Schema>, required: string[] = []): Schema => ({
  type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false,
});
const text = (bytes = 65_536, nonempty = false): Schema => ({
  type: "string", maxLength: bytes, ...(nonempty ? { minLength: 1 } : {}),
  description: `At most ${bytes} UTF-8 bytes; checked by the runtime.`,
});
const integer = (minimum: number, maximum: number): Schema => ({ type: "integer", minimum, maximum });
const number = (minimum: number, maximum: number): Schema => ({ type: "number", minimum, maximum });
const enumeration = (...values: (string | number)[]): Schema => ({ enum: values });
const boolean: Schema = { type: "boolean" };
const identifier: Schema = { type: "string", pattern: "^[a-zA-Z0-9_-]{1,100}$" };
const array = (items: Schema, maxItems: number): Schema => ({ type: "array", items, maxItems });
const roles = "alert alertdialog application article banner blockquote button caption cell checkbox code columnheader combobox complementary contentinfo definition deletion dialog directory document emphasis feed figure form generic grid gridcell group heading img insertion link list listbox listitem log main marquee math menu menubar menuitem menuitemcheckbox menuitemradio meter navigation none note option paragraph presentation progressbar radio radiogroup region row rowgroup rowheader scrollbar search searchbox separator slider spinbutton status strong subscript superscript switch tab table tablist tabpanel term textbox time timer toolbar tooltip tree treegrid treeitem".split(" ");
const targetOptions = {
  exact: boolean,
  frame: { ...array(text(4096, true), 8), description: "Frame selectors from outermost to innermost; at most eight." },
  nth: integer(0, 999),
};
const target: Schema = {
  oneOf: [
    object({ by: enumeration("selector", "text", "label", "testId"), value: text(4096, true), ...targetOptions }, ["by", "value"]),
    object({ by: enumeration("role"), role: enumeration(...roles), name: text(4096), ...targetOptions }, ["by", "role"]),
  ],
};
const point = object({ x: number(0, 100_000), y: number(0, 100_000) }, ["x", "y"]);
const upload = object({
  name: { ...text(255, true), pattern: "^[^\\\\/\\u0000]+$(?![\\s\\S])", not: { enum: [".", ".."] } },
  mimeType: text(255),
  base64: {
    type: "string", maxLength: 6 * 1024 * 1024,
    // Canonical base64: the final sextet has zero unused bits. The negative
    // lookahead prevents JavaScript's $ from accepting a trailing newline.
    pattern: "^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/][AQgw]==|[A-Za-z0-9+/]{2}[AEIMQUYcgkosw048]=)?$(?![\\s\\S])",
    description: "Canonical padded base64; all files combined must decode to at most 4 MiB (runtime enforced).",
  },
}, ["name", "mimeType", "base64"]);
const command = (op: string, properties: Record<string, Schema> = {}, required: string[] = []): Schema =>
  object({ op: { const: op }, ...properties }, ["op", ...required]);
const targeted = (op: string, properties: Record<string, Schema> = {}, required: string[] = []): Schema => ({
  ...command(op, { selector: text(65_536, true), target, ...properties }, required),
  oneOf: [{ required: ["selector"] }, { required: ["target"] }],
});

/** Every structured BrowserCommand. Call validateBrowserCommand before execution. */
export const browserCommandSchema: Record<string, unknown> = {
  type: "object",
  description: "A single structured browser operation. Required browser capabilities vary by backend. Byte limits and aggregate upload size are checked by Station before execution.",
  oneOf: [
    targeted("fill", { value: text() }, ["value"]),
    targeted("select", { values: array(text(), 100) }, ["values"]),
    targeted("check", { checked: boolean }, ["checked"]),
    ...["hover", "click", "focus", "download"].map((op) => targeted(op)),
    targeted("press", { key: text(256, true) }, ["key"]),
    targeted("waitFor", { state: enumeration("attached", "detached", "visible", "hidden") }),
    targeted("upload", { files: { ...array(upload, 16), description: "At most 16 files and 4 MiB of decoded bytes in total; an empty array clears the file input." } }, ["files"]),
    command("scroll", { x: number(-10_000_000, 10_000_000), y: number(-10_000_000, 10_000_000) }, ["x", "y"]),
    ...["content", "back", "forward", "reload", "pages", "traceStart", "traceStop"].map((op) => command(op)),
    command("newPage", { url: text() }),
    ...["selectPage", "closePage"].map((op) => command(op, { pageId: identifier }, ["pageId"])),
    ...["downloadRead", "downloadDelete"].map((op) => command(op, { artifactId: identifier }, ["artifactId"])),
    command("mouseClick", { x: number(0, 100_000), y: number(0, 100_000), button: enumeration("left", "middle", "right"), clickCount: enumeration(1, 2) }, ["x", "y"]),
    command("mouseMove", { x: number(0, 100_000), y: number(0, 100_000) }, ["x", "y"]),
    command("drag", { source: target, destination: target }, ["source", "destination"]),
    command("dragCoordinates", { from: point, to: point, steps: integer(1, 100) }, ["from", "to"]),
    command("inspect", { target, maxElements: integer(1, 500), maxTextLength: integer(1, 4096) }),
    command("accessibility", { target, depth: integer(1, 20), boxes: boolean }),
    {
      ...command("dialog", { action: enumeration("accept", "dismiss"), promptText: text(4096), expiresInMs: integer(1, 30_000) }, ["action"]),
      if: { required: ["promptText"] }, then: { properties: { action: { const: "accept" } } },
    },
    command("diagnostics", { consoleText: boolean, clear: boolean }),
  ],
};

/** Options for a new browser session; does not resume a previous live process. */
export const browserOpenOptionsSchema: Record<string, unknown> = object({
  profileId: identifier,
  viewport: object({ width: integer(1, 4096), height: integer(1, 4096) }, ["width", "height"]),
  idleTimeoutMs: integer(100, 86_400_000),
});
