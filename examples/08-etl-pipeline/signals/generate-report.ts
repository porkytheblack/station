import { signal, z } from "simple-signal";

export const generateReport = signal("generate-report")
  .input(z.object({ inserted: z.number(), updated: z.number(), source: z.string() }))
  .output(z.object({ reportId: z.string(), summary: z.string() }))
  .run(async (input) => {
    const total = input.inserted + input.updated;
    const reportId = `rpt_${Date.now().toString(36)}`;
    const summary = `ETL complete. Source: ${input.source}. ${total} records processed (${input.inserted} new, ${input.updated} updated).`;
    console.log(`[report] ${summary}`);
    return { reportId, summary };
  });
