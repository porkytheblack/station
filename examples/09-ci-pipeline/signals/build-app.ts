import { signal, z } from "simple-signal";

export const buildApp = signal("build-app")
  .input(z.object({ repo: z.string(), branch: z.string(), commitSha: z.string(), workdir: z.string() }))
  .output(z.object({ artifactId: z.string(), sizeKb: z.number() }))
  .timeout(20_000)
  .step("compile", async (input) => {
    console.log(`[build] Compiling TypeScript...`);
    await new Promise((r) => setTimeout(r, 800));
    return { ...input, compiled: true };
  })
  .step("bundle", async (prev) => {
    console.log(`[build] Bundling with esbuild...`);
    await new Promise((r) => setTimeout(r, 600));
    const sizeKb = 340 + Math.floor(Math.random() * 60);
    return { workdir: prev.workdir, commitSha: prev.commitSha, sizeKb };
  })
  .step("upload-artifact", async (prev) => {
    const artifactId = `build_${prev.commitSha.slice(0, 7)}_${Date.now().toString(36)}`;
    console.log(`[build] Uploading artifact ${artifactId} (${prev.sizeKb}KB)...`);
    await new Promise((r) => setTimeout(r, 400));
    return { artifactId, sizeKb: prev.sizeKb };
  })
  .build();
