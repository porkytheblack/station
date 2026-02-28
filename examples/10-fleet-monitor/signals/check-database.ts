import { signal, z } from "simple-signal";

export const checkDatabase = signal("check-database")
  .output(z.object({ service: z.string(), healthy: z.boolean(), latencyMs: z.number(), connections: z.number(), checkedAt: z.string() }))
  .every("8s")
  .run(async () => {
    const latencyMs = 5 + Math.floor(Math.random() * 30);
    const connections = 10 + Math.floor(Math.random() * 40);
    await new Promise((r) => setTimeout(r, latencyMs));

    if (Math.random() < 0.05) {
      throw new Error(`Database connection pool exhausted (${connections} active)`);
    }

    console.log(`[check-database] OK ${latencyMs}ms, ${connections} connections`);
    return { service: "postgres-primary", healthy: true, latencyMs, connections, checkedAt: new Date().toISOString() };
  });
