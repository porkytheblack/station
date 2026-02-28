import { signal, z } from "simple-signal";

export const notify = signal("notify")
  .input(z.object({ environment: z.string(), url: z.string(), deployId: z.string() }))
  .run(async (input) => {
    console.log(`[notify] Sending deployment notification...`);
    await new Promise((r) => setTimeout(r, 200));
    console.log(`[notify] Deployed ${input.deployId} to ${input.environment} → ${input.url}`);
  });
