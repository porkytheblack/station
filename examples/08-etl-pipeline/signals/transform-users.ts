import { signal, z } from "station-signal";

const userRecord = z.object({ id: z.number(), name: z.string(), email: z.string() });

export const transformUsers = signal("transform-users")
  .input(z.object({ records: z.array(userRecord), source: z.string() }))
  .output(z.object({ records: z.array(userRecord), source: z.string(), transformedAt: z.string() }))
  .timeout(15_000)
  .step("clean", async (input) => {
    console.log(`[transform] Cleaning ${input.records.length} records...`);
    await new Promise((r) => setTimeout(r, 300));
    const cleaned = input.records.map((r: { id: number; name: string; email: string }) => ({
      ...r,
      name: r.name.trim(),
      email: r.email.toLowerCase().trim(),
    }));
    return { records: cleaned, source: input.source };
  })
  .step("normalize", async (prev) => {
    console.log(`[transform] Normalizing fields...`);
    await new Promise((r) => setTimeout(r, 250));
    const normalized = prev.records.map((r: { id: number; name: string; email: string }) => ({
      ...r,
      name: r.name.replace(/\s+/g, " "),
      email: r.email.split("@").map((p: string, i: number) => (i === 0 ? p : p.toLowerCase())).join("@"),
    }));
    return { records: normalized, source: prev.source };
  })
  .step("enrich", async (prev) => {
    console.log(`[transform] Enriching with metadata...`);
    await new Promise((r) => setTimeout(r, 200));
    return {
      records: prev.records,
      source: prev.source,
      transformedAt: new Date().toISOString(),
    };
  })
  .build();
