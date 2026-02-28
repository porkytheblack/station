import { signal, z } from "simple-signal";

export const checkQueue = signal("check-queue")
  .output(z.object({ service: z.string(), healthy: z.boolean(), depth: z.number(), consumers: z.number(), checkedAt: z.string() }))
  .every("10s")
  .run(async () => {
    const depth = Math.floor(Math.random() * 500);
    const consumers = 2 + Math.floor(Math.random() * 6);
    await new Promise((r) => setTimeout(r, 50));

    if (Math.random() < 0.08) {
      throw new Error(`Queue broker unreachable (depth was ${depth})`);
    }

    console.log(`[check-queue] OK depth=${depth}, consumers=${consumers}`);
    return { service: "rabbitmq", healthy: true, depth, consumers, checkedAt: new Date().toISOString() };
  });
