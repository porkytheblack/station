export interface FileEntry { name: string; path: string; type: "file" | "directory" | "symlink"; size: number; modifiedAt: string }
export interface FileList { entries: FileEntry[]; nextOffset?: number }
export interface FileRead { path: string; base64: string; bytes: number; totalBytes: number; nextOffset: number }
export interface FileWrite { base64: string; createParents?: boolean }
export interface TerminalInput { cwd?: string; cols?: number; rows?: number }
export interface TerminalSession { id: string; sandboxId: string; status: "running" | "exited" | "interrupted"; cols: number; rows: number; startedAt: string; finishedAt?: string; exitCode: number | null }
export interface TerminalOutput extends TerminalSession { data: string; startOffset: number; offset: number; nextOffset: number; truncated: boolean }
export interface ServiceRestart { policy: "never" | "on-failure" | "always"; maxRestarts: number; delayMs: number }
export interface ServiceInput { name: string; command: string; cwd?: string; restart?: ServiceRestart }
export interface ServiceAttempt { startedAt: string; finishedAt?: string; exitCode: number | null }
export interface SandboxService { id: string; sandboxId: string; name: string; command: string; cwd?: string; restart: ServiceRestart; status: "running" | "restarting" | "stopped" | "failed" | "interrupted"; restartCount: number; stdout: string; stderr: string; truncated: boolean; createdAt: string; startedAt?: string; finishedAt?: string; exitCode: number | null; history: ServiceAttempt[] }
