import { signal, z } from "simple-signal";

const userRecord = z.object({ id: z.number(), name: z.string(), email: z.string() });

export const loadUsers = signal("load-users")
  .input(
    z.object({ records: z.array(userRecord), source: z.string(), transformedAt: z.string() }),
  )
  .output(z.object({ inserted: z.number(), updated: z.number(), source: z.string() }))
  .timeout(20_000)
  .retries(2)
  .step("upsert", async (input) => {
    console.log(`[load] Upserting ${input.records.length} records into target database...`);
    await new Promise((r) => setTimeout(r, 600));

    // Simulate random transient failure (10% chance)
    if (Math.random() < 0.1) {
      throw new Error("Connection to target database lost");
    }

    const inserted = Math.floor(input.records.length * 0.7);
    const updated = input.records.length - inserted;
    console.log(`[load] Inserted ${inserted}, updated ${updated}.`);
    return { inserted, updated, source: input.source };
  })
  .step("verify", async (prev) => {
    console.log(`[load] Verifying load integrity...`);
    await new Promise((r) => setTimeout(r, 300));
    const total = prev.inserted + prev.updated;
    console.log(`[load] Verified ${total} records in target.`);
    return prev;
  })
  .build();
