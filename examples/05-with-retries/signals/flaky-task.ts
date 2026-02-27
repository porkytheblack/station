import { signal, z } from "simple-signal";

export const flakyTask = signal("flakyTask")
  .input(z.object({ message: z.string() }))
  .timeout(3_000)
  .retries(3)
  .run(async (input) => {
    // 60% chance of failure — with 4 total attempts, very likely to succeed
    const shouldFail = Math.random() < 0.6;

    if (shouldFail) {
      console.log(`[flakyTask] Processing "${input.message}" — failed! (will retry)`);
      throw new Error("Random failure");
    }

    console.log(`[flakyTask] Processing "${input.message}" — success!`);
  });
