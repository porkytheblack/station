import { signal, z } from "simple-signal";

export const extractUsers = signal("extract-users")
  .input(z.object({ source: z.string(), batchSize: z.number() }))
  .output(
    z.object({ records: z.array(z.object({ id: z.number(), name: z.string(), email: z.string() })), source: z.string() }),
  )
  .timeout(15_000)
  .step("connect", async (input) => {
    console.log(`[extract] Connecting to ${input.source}...`);
    await new Promise((r) => setTimeout(r, 400));
    return { ...input, connected: true };
  })
  .step("query", async (prev) => {
    console.log(`[extract] Querying ${prev.batchSize} records from ${prev.source}...`);
    await new Promise((r) => setTimeout(r, 800));

    // Simulate fetched records
    const records = Array.from({ length: prev.batchSize }, (_, i) => ({
      id: i + 1,
      name: `User ${i + 1}`,
      email: `user${i + 1}@${prev.source}`,
      raw_signup: `2024-0${(i % 9) + 1}-15`,
      status_code: i % 3 === 0 ? "A" : i % 3 === 1 ? "I" : "P",
    }));
    console.log(`[extract] Fetched ${records.length} records.`);
    return { records, source: prev.source };
  })
  .step("validate", async (prev) => {
    console.log(`[extract] Validating ${prev.records.length} records...`);
    const valid = prev.records.filter((r: { email: string }) => r.email.includes("@"));
    const dropped = prev.records.length - valid.length;
    if (dropped > 0) console.log(`[extract] Dropped ${dropped} invalid records.`);
    return {
      records: valid.map((r: { id: number; name: string; email: string }) => ({
        id: r.id,
        name: r.name,
        email: r.email,
      })),
      source: prev.source,
    };
  })
  .build();
