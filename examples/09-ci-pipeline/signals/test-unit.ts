import { signal, z } from "station-signal";

export const testUnit = signal("test-unit")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ passed: z.boolean(), total: z.number(), failed: z.number(), duration: z.number() }))
  .timeout(15_000)
  .retries(2)
  .run(async (input) => {
    console.log(`[test-unit] Running unit tests in ${input.workdir}...`);
    await new Promise((r) => setTimeout(r, 1200));

    // 30% flaky failure rate
    if (Math.random() < 0.3) {
      const failCount = Math.floor(Math.random() * 3) + 1;
      console.log(`[test-unit] ${failCount} test(s) failed.`);
      throw new Error(`${failCount} unit test(s) failed`);
    }

    const total = 142;
    const duration = 1200 + Math.floor(Math.random() * 300);
    console.log(`[test-unit] ${total} tests passed in ${duration}ms.`);
    return { passed: true, total, failed: 0, duration };
  });
