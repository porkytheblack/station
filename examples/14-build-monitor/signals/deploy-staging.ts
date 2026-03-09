import { signal, z } from "station-signal";
import { eq } from "drizzle-orm";
import { db } from "../lib/db.js";
import { deployments } from "../lib/schema.js";
import { newId } from "../lib/id.js";
import { deployNotification, sendNotification } from "../lib/notify.js";

export const deployStaging = signal("deploy-staging")
  .input(z.object({
    buildId: z.string(),
    artifactPath: z.string(),
    repo: z.string(),
  }))
  .run(async (input) => {
    const deployId = newId("dpl");
    console.log(`[deploy] Deploying ${input.buildId} to staging...`);

    db.insert(deployments).values({
      id: deployId,
      buildId: input.buildId,
      environment: "staging",
      status: "deploying",
    }).run();

    // Simulate deployment
    await new Promise((r) => setTimeout(r, 800));

    const url = `https://staging-${input.buildId.slice(4, 10)}.example.com`;
    db.update(deployments)
      .set({ status: "live", url, deployedAt: new Date() })
      .where(eq(deployments.id, deployId))
      .run();

    await sendNotification(deployNotification(
      { environment: "staging", status: "live", url },
      input.repo,
    ));

    console.log(`[deploy] Staging live at ${url}`);
    return { deployId, url };
  });
