import { signal, z } from "station-signal";

export const syncCatalog = signal("sync-catalog")
  .input(z.object({ source: z.string(), release: z.string() }))
  .output(z.object({ source: z.string(), release: z.string(), records: z.number() }))
  .concurrency({ station: 2, network: 4 })
  .retries(2)
  .run(async ({ source, release }) => {
    await new Promise((resolve) => setTimeout(resolve, 250));
    console.log(`Synced ${source} for ${release}`);
    return { source, release, records: 1_248 };
  });
