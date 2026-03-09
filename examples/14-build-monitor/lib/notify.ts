// Notification utilities — shared between signals and the app

import type { Build, Deployment } from "./schema.js";

export type Channel = "slack" | "email" | "webhook";

export interface Notification {
  channel: Channel;
  title: string;
  body: string;
  metadata?: Record<string, string>;
}

export function buildStartedNotification(build: Pick<Build, "repo" | "branch" | "commit" | "triggeredBy">): Notification {
  return {
    channel: "slack",
    title: `Build started: ${build.repo}`,
    body: `Branch \`${build.branch}\` (${build.commit.slice(0, 7)}) triggered by ${build.triggeredBy}`,
    metadata: { repo: build.repo, branch: build.branch },
  };
}

export function buildFinishedNotification(build: Pick<Build, "repo" | "branch" | "status" | "duration">): Notification {
  const emoji = build.status === "success" ? "ok" : "x";
  return {
    channel: "slack",
    title: `Build ${build.status}: ${build.repo}`,
    body: `Branch \`${build.branch}\` ${build.status} in ${build.duration ?? 0}ms [${emoji}]`,
    metadata: { repo: build.repo, status: build.status },
  };
}

export function deployNotification(deploy: Pick<Deployment, "environment" | "status" | "url">, repo: string): Notification {
  return {
    channel: "slack",
    title: `Deploy ${deploy.status}: ${repo} → ${deploy.environment}`,
    body: deploy.url ? `Live at ${deploy.url}` : `Deployment ${deploy.status}`,
    metadata: { environment: deploy.environment },
  };
}

export async function sendNotification(notification: Notification): Promise<void> {
  // Simulated — would post to Slack/email/webhook in real usage
  await new Promise((r) => setTimeout(r, 50));
  console.log(`[notify:${notification.channel}] ${notification.title} — ${notification.body}`);
}
