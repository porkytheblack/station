// Simulated GitHub API client — shared between signals and the app

export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  timestamp: Date;
}

export interface RepoStatus {
  repo: string;
  branch: string;
  latestCommit: CommitInfo;
  hasChanges: boolean;
}

export async function fetchLatestCommit(repo: string, branch: string): Promise<CommitInfo> {
  // Simulated — in real usage this would call GitHub API
  await new Promise((r) => setTimeout(r, 200));
  return {
    sha: Math.random().toString(36).slice(2, 10),
    message: `chore: automated build from ${branch}`,
    author: "ci-bot",
    timestamp: new Date(),
  };
}

export async function updateCommitStatus(
  repo: string,
  sha: string,
  status: "pending" | "success" | "failure",
): Promise<void> {
  // Simulated GitHub commit status update
  await new Promise((r) => setTimeout(r, 100));
  console.log(`[github] ${repo}@${sha} → ${status}`);
}

export function repoSlug(repo: string): string {
  return repo.replace(/[^a-z0-9-]/gi, "-").toLowerCase();
}
