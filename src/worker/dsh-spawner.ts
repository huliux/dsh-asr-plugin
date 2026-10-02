import type { WorkerProcessHandle, WorkerSpawner } from "./process.js";

interface DshSpawnSpec {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly stdio: {
    readonly stdin: "pipe";
    readonly stdout: "pipe";
    readonly stderr: "pipe";
  };
  readonly graceMs: number;
  readonly env: NodeJS.ProcessEnv;
}

export interface DshSubprocessPort {
  spawn(spec: DshSpawnSpec): WorkerProcessHandle;
}

function exactChildEnvironment(
  environment: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const exact: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) exact[key] = undefined;
  for (const [key, value] of Object.entries(environment)) exact[key] = value;
  return exact;
}

export function createDshWorkerSpawner(subprocess: DshSubprocessPort): WorkerSpawner {
  return {
    spawn(spec) {
      return subprocess.spawn({
        argv: spec.argv,
        cwd: spec.cwd,
        stdio: { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
        graceMs: spec.graceMs,
        env: exactChildEnvironment(spec.environment),
      });
    },
  };
}
