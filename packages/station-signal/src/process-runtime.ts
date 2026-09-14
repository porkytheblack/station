import { spawn, type ChildProcess } from "node:child_process";

export interface ProcessSpawnOptions {
  /** Station's compiled signal or beacon bootstrap. */
  entrypoint: string;
  env: Record<string, string>;
  /** Optional TypeScript loader for runtimes that need one. */
  tsxImport?: string;
}

/**
 * Execution runtime for Station children, independent of the controller runtime.
 * Implementations must return a Node-compatible ChildProcess with piped output
 * and JSON IPC. They must honor env and support send(), disconnect() and kill().
 * This selects a language runtime; it does not provide sandbox isolation.
 */
export interface ProcessRuntime {
  readonly name: string;
  spawn(options: ProcessSpawnOptions): ChildProcess;
}

export class NodeProcessRuntime implements ProcessRuntime {
  readonly name = "node";
  constructor(private readonly executable = "node") {}

  spawn({ entrypoint, env, tsxImport }: ProcessSpawnOptions): ChildProcess {
    return spawn(this.executable, tsxImport ? ["--import", tsxImport, entrypoint] : [entrypoint], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
  }
}

/** Bun executes TypeScript natively; it does not load Node's tsx hook. */
export class BunProcessRuntime implements ProcessRuntime {
  readonly name = "bun";
  constructor(private readonly executable = "bun") {}

  spawn({ entrypoint, env }: ProcessSpawnOptions): ChildProcess {
    return spawn(this.executable, [entrypoint], {
      env,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      serialization: "json",
    });
  }
}
