// A dedicated Bun process for ONE WebView. Do not combine unrelated sessions:
// Bun's Chrome backend shares browser/profile state across views in a process.
import { createInterface } from "node:readline";

interface View {
  navigate(url: string): Promise<void>;
  evaluate(script: string): Promise<unknown>;
  click(selector: string): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  screenshot(options: { format: "png"; encoding: "buffer" }): Promise<Uint8Array>;
  close(): void;
}
const runtime = (globalThis as unknown as { Bun?: { WebView?: { new (options: unknown): View; closeAll(): void } } }).Bun;
let view: View | undefined;
const shutdown = () => {
  view?.close();
  runtime?.WebView?.closeAll();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
const input = createInterface({ input: process.stdin, terminal: false });
for await (const line of input) {
  let id: number | undefined;
  try {
    const request = JSON.parse(line);
    id = request.id;
    let value: unknown;
    if (request.method === "open") {
      if (!runtime?.WebView) throw new Error("This Bun runtime does not provide Bun.WebView.");
      if (view) throw new Error("View already open.");
      view = new runtime.WebView(request.argument);
      await view.navigate("about:blank");
    } else {
      if (!view) throw new Error("View is not open.");
      switch (request.method) {
        case "navigate": await view.navigate(request.argument); break;
        case "evaluate": value = await view.evaluate(request.argument); break;
        case "click": await view.click(request.argument); break;
        case "type": await view.type(request.argument); break;
        case "press": await view.press(request.argument); break;
        case "screenshot": value = Buffer.from(await view.screenshot({ format: "png", encoding: "buffer" })).toString("base64"); break;
        case "close": view.close(); break;
        default: throw new Error("Unknown browser operation.");
      }
    }
    process.stdout.write(JSON.stringify({ id, value: value ?? null }) + "\n");
    if (request.method === "close") break;
  } catch (error) {
    process.stdout.write(JSON.stringify({ id, error: error instanceof Error ? error.message : "Browser operation failed." }) + "\n");
  }
}
shutdown();
