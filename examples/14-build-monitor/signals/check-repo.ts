import { signal, z } from "station-signal";
import { fetchLatestCommit, updateCommitStatus } from "../lib/github.js";
import { db } from "../lib/db.js";
import { builds } from "../lib/schema.js";
import { newId } from "../lib/id.js";
import { buildStartedNotification, sendNotification } from "../lib/notify.js";

export const checkRepo = signal("check-repo")
  .input(z.object({
    repo: z.string(),
    branch: z.string().default("main"),
    triggeredBy: z.string().default("ci"),
  }))
  .run(async (input) => {
    const commit = await fetchLatestCommit(input.repo, input.branch);
    await updateCommitStatus(input.repo, commit.sha, "pending");

    const buildId = newId("bld");
    db.insert(builds).values({
      id: buildId,
      repo: input.repo,
      branch: input.branch,
      commit: commit.sha,
      status: "running",
      startedAt: new Date(),
      triggeredBy: input.triggeredBy,
    }).run();

    await sendNotification(buildStartedNotification({
      repo: input.repo,
      branch: input.branch,
      commit: commit.sha,
      triggeredBy: input.triggeredBy,
    }));

    return { buildId, commit: commit.sha };
  });
