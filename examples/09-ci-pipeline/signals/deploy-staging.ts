import { signal, z } from "simple-signal";

export const deployStaging = signal("deploy-staging")
  .input(z.object({ artifactId: z.string(), sizeKb: z.number() }))
  .output(z.object({ environment: z.string(), url: z.string(), deployId: z.string() }))
  .timeout(15_000)
  .step("provision", async (input) => {
    console.log(`[deploy-staging] Provisioning staging environment...`);
    await new Promise((r) => setTimeout(r, 500));
    return input;
  })
  .step("deploy", async (prev) => {
    console.log(`[deploy-staging] Deploying artifact ${prev.artifactId}...`);
    await new Promise((r) => setTimeout(r, 700));
    const deployId = `deploy_stg_${Date.now().toString(36)}`;
    return {
      environment: "staging",
      url: "https://staging.app.example.com",
      deployId,
    };
  })
  .build();
