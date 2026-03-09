import { signal, z } from "station-signal";
import { db } from "../lib/db.js";
import { testResults } from "../lib/schema.js";
import { newId } from "../lib/id.js";

export const runTests = signal("run-tests")
  .input(z.object({
    buildId: z.string(),
    artifactPath: z.string(),
  }))
  .run(async (input) => {
    console.log(`[test] Running tests for build ${input.buildId}...`);

    // Simulate test suites
    const suites = [
      { suite: "unit", passed: 47, failed: 0, skipped: 2, duration: 1200 },
      { suite: "integration", passed: 12, failed: 0, skipped: 1, duration: 3400 },
      { suite: "e2e", passed: 8, failed: 0, skipped: 0, duration: 8500 },
    ];

    for (const s of suites) {
      db.insert(testResults).values({
        id: newId("tst"),
        buildId: input.buildId,
        ...s,
      }).run();
      console.log(`[test] ${s.suite}: ${s.passed} passed, ${s.failed} failed, ${s.skipped} skipped (${s.duration}ms)`);
    }

    const totalFailed = suites.reduce((sum, s) => sum + s.failed, 0);
    return { buildId: input.buildId, passed: totalFailed === 0, totalFailed };
  });
