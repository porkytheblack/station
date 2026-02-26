import { signal, z } from "simple-signal";

export const flakyTask = signal("flakyTask")
  .input(z.object({ message: z.string() }))
  .timeout(5_000)
  .retries(3)
  .run(async (input) => {
    const shouldFail = Math.random() < 0.5;

    if (shouldFail) {
      console.log(`[flakyTask] Processing "${input.message}" — failed! (will retry)`);
      throw new Error("Random failure");
    }

    console.log(`[flakyTask] Processing "${input.message}" — success!`);
  });
