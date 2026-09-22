import { signal, z } from "../../src/index.js";

export const runtimeSignal = signal("runtime-signal")
  .input(z.object({ fail: z.boolean().optional(), delayMs: z.number().optional() }))
  .run(async ({ fail, delayMs }) => {
    if (fail) throw new Error("runtime fixture failure");
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { runtime: "bun" in process.versions ? "bun" : "node", value: process.env.RUNTIME_TEST_VALUE };
  });
