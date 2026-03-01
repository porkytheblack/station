import { signal, z } from "station-signal";

export const testIntegration = signal("test-integration")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ passed: z.boolean(), total: z.number(), failed: z.number(), duration: z.number() }))
  .timeout(30_000)
  .retries(1)
  .step("setup-fixtures", async (input) => {
    console.log(`[test-integration] Setting up test fixtures...`);
    await new Promise((r) => setTimeout(r, 500));
    return input;
  })
  .step("run-tests", async (input) => {
    console.log(`[test-integration] Running integration tests...`);
    await new Promise((r) => setTimeout(r, 1800));

    // 20% flaky failure rate
    if (Math.random() < 0.2) {
      throw new Error("Database connection timeout during test");
    }

    const total = 38;
    const duration = 1800 + Math.floor(Math.random() * 500);
    console.log(`[test-integration] ${total} tests passed in ${duration}ms.`);
    return { passed: true, total, failed: 0, duration };
  })
  .step("teardown", async (prev) => {
    console.log(`[test-integration] Cleaning up fixtures...`);
    await new Promise((r) => setTimeout(r, 200));
    return prev;
  })
  .build();
