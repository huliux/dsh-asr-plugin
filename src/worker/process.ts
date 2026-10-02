import type { Readable, Writable } from "node:stream";

export interface WorkerProcessOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface WorkerProcessHandle {
  readonly stdin: Writable | undefined;
  readonly stdout: Readable | undefined;
  readonly stderr: Readable | undefined;
  readonly done: Promise<WorkerProcessOutcome>;
  terminate(): void;
  waitForExit(signal?: AbortSignal): Promise<boolean>;
}

export interface WorkerLaunchSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly graceMs: number;
}

export interface WorkerSpawner {
  spawn(spec: WorkerLaunchSpec): WorkerProcessHandle;
}
