import { signal, z } from "station-signal";

export const deployProd = signal("deploy-prod")
  .input(z.object({ environment: z.string(), url: z.string(), deployId: z.string() }))
  .output(z.object({ environment: z.string(), url: z.string(), deployId: z.string() }))
  .timeout(20_000)
  .step("health-check-staging", async (input) => {
    console.log(`[deploy-prod] Verifying staging at ${input.url}...`);
    await new Promise((r) => setTimeout(r, 400));
    console.log(`[deploy-prod] Staging healthy.`);
    return input;
  })
  .step("promote-to-prod", async (prev) => {
    console.log(`[deploy-prod] Promoting to production...`);
    await new Promise((r) => setTimeout(r, 900));
    const deployId = `deploy_prod_${Date.now().toString(36)}`;
    console.log(`[deploy-prod] Live at https://app.example.com`);
    return {
      environment: "production",
      url: "https://app.example.com",
      deployId,
    };
  })
  .build();
