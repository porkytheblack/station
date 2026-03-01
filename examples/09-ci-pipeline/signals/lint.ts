import { signal, z } from "station-signal";

export const lint = signal("lint")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ passed: z.boolean(), warnings: z.number(), errors: z.number() }))
  .timeout(10_000)
  .run(async (input) => {
    console.log(`[lint] Running ESLint on ${input.workdir}...`);
    await new Promise((r) => setTimeout(r, 400));
    const warnings = Math.floor(Math.random() * 8);
    console.log(`[lint] Passed. ${warnings} warnings, 0 errors.`);
    return { passed: true, warnings, errors: 0 };
  });
