import { signal, z } from "station-signal";
import { repoSlug } from "../lib/github.js";

export const runBuild = signal("run-build")
  .input(z.object({
    buildId: z.string(),
    repo: z.string(),
    commit: z.string(),
  }))
  .run(async (input) => {
    const slug = repoSlug(input.repo);
    console.log(`[build] Building ${slug}@${input.commit.slice(0, 7)}...`);

    // Simulate build steps
    await new Promise((r) => setTimeout(r, 500));
    console.log(`[build] Installing dependencies...`);
    await new Promise((r) => setTimeout(r, 300));
    console.log(`[build] Compiling TypeScript...`);
    await new Promise((r) => setTimeout(r, 400));
    console.log(`[build] Build complete for ${slug}`);

    return {
      buildId: input.buildId,
      artifactPath: `/tmp/builds/${slug}/${input.commit.slice(0, 7)}`,
      success: true,
    };
  });
