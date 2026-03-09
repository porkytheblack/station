import { signal, z } from "station-signal";
import { db } from "../lib/db.js";
import { builds } from "../lib/schema.js";
import { eq } from "drizzle-orm";
import { buildFinishedNotification, sendNotification } from "../lib/notify.js";
import { updateCommitStatus } from "../lib/github.js";

export const sendBuildNotification = signal("send-notification")
  .input(z.object({
    buildId: z.string(),
    status: z.enum(["success", "failure"]),
    repo: z.string(),
    commit: z.string(),
  }))
  .run(async (input) => {
    // Update build record
    const now = new Date();
    db.update(builds)
      .set({ status: input.status, finishedAt: now })
      .where(eq(builds.id, input.buildId))
      .run();

    // Update GitHub commit status
    await updateCommitStatus(input.repo, input.commit, input.status);

    // Get build for duration calc
    const build = db.select().from(builds).where(eq(builds.id, input.buildId)).get();
    const duration = build?.startedAt ? now.getTime() - build.startedAt.getTime() : undefined;

    await sendNotification(buildFinishedNotification({
      repo: input.repo,
      branch: build?.branch ?? "unknown",
      status: input.status,
      duration: duration ?? null,
    }));

    return { notified: true };
  });
