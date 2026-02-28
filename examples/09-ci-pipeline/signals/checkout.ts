import { signal, z } from "simple-signal";

export const checkout = signal("checkout")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string() }))
  .output(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .timeout(10_000)
  .run(async (input) => {
    console.log(`[checkout] Cloning ${input.repo}@${input.branch} (${input.commitSha.slice(0, 7)})...`);
    await new Promise((r) => setTimeout(r, 600));
    const workdir = `/tmp/ci/${input.commitSha.slice(0, 7)}`;
    console.log(`[checkout] Workspace ready at ${workdir}`);
    return { ...input, workdir };
  });
