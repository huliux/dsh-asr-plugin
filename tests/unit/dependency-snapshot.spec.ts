import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const script = resolve("scripts/dependency-snapshot.mjs");
interface Entry {
  package_url: string;
  relationship: string;
  scope: string;
  dependencies: string[];
}
interface Snapshot {
  sha: string;
  ref: string;
  job: { id: string; correlator: string };
  manifests: { "pnpm-lock.yaml": { resolved: Record<string, Entry> } };
}

function invoke(tree: unknown, overrides: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-dependency-snapshot-"));
  temporaryRoots.push(root);
  const input = join(root, "tree.json");
  const output = join(root, "snapshot.json");
  writeFileSync(input, JSON.stringify(tree));
  const env = { ...process.env, GITHUB_SHA: "a".repeat(40), GITHUB_REF: "refs/heads/main",
    GITHUB_RUN_ID: "123", GITHUB_RUN_ATTEMPT: "1", GITHUB_REPOSITORY: "owner/repo", ...overrides };
  const result = spawnSync(process.execPath, [script, input, output], { env, encoding: "utf8" });
  return { result, input, output, env };
}

function generate(tree: unknown, overrides: NodeJS.ProcessEnv = {}): Snapshot {
  const run = invoke(tree, overrides);
  expect(run.result.status, run.result.stderr).toBe(0);
  return JSON.parse(readFileSync(run.output, "utf8")) as Snapshot;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("dependency snapshot public CLI", () => {
  it("keeps both versions and optional dependencies for other platforms", () => {
    const snapshot = generate([{ path: "/private/local-profile", dependencies: {
      app: { version: "1.0.0", dependencies: { undici: { version: "6.29.1" } },
        optionalDependencies: { "other-platform": { version: "2.0.0" } } },
    }, devDependencies: {
      test: { version: "3.0.0", dependencies: { undici: { version: "8.12.2" } } },
    } }]);
    const entries = snapshot.manifests["pnpm-lock.yaml"].resolved;
    expect(Object.keys(entries)).toHaveLength(5);
    expect(entries["pkg:npm/undici@6.29.1"]).toMatchObject({ scope: "runtime", relationship: "indirect" });
    expect(entries["pkg:npm/undici@8.12.2"]).toMatchObject({ scope: "development", relationship: "indirect" });
    expect(entries["pkg:npm/other-platform@2.0.0"]?.scope).toBe("runtime");
    expect(JSON.stringify(snapshot)).not.toContain("/private/local-profile");
    for (const entry of Object.values(entries)) {
      expect(entry.dependencies.every(id => entries[id] !== undefined)).toBe(true);
    }
  });

  it("merges deduped occurrences before propagating runtime scope across cycles", () => {
    const entries = generate([{ devDependencies: {
      shared: { version: "1.0.0", dependencies: {
        child: { version: "2.0.0", dependencies: { shared: { version: "1.0.0", deduped: true } } },
      } },
      "dev-only": { version: "3.0.0" },
    }, dependencies: { shared: { version: "1.0.0", deduped: true } } }])
      .manifests["pnpm-lock.yaml"].resolved;
    expect(entries["pkg:npm/shared@1.0.0"]).toMatchObject({ scope: "runtime", relationship: "direct",
      dependencies: ["pkg:npm/child@2.0.0"] });
    expect(entries["pkg:npm/child@2.0.0"]?.scope).toBe("runtime");
    expect(entries["pkg:npm/dev-only@3.0.0"]?.scope).toBe("development");
  });

  it("uses a scoped package's real identity rather than its alias or local path", () => {
    const entries = generate([{ devDependencies: {
      alias: { from: "@scope/actual", version: "1.2.3-rc.5", path: "/Users/example/private" },
    } }]).manifests["pnpm-lock.yaml"].resolved;
    expect(Object.keys(entries)).toEqual(["pkg:npm/%40scope/actual@1.2.3-rc.5"]);
  });

  it.each([
    { tree: [], env: {} },
    { tree: [{ dependencies: { local: { version: "file:../local" } } }], env: {} },
    { tree: [{ dependencies: { app: { version: "1.0.0" } } }], env: { GITHUB_REF: "refs/pull/7/merge" } },
  ])("rejects empty, unresolved or non-default-branch input", ({ tree, env }) => {
    expect(invoke(tree, env).result.status).not.toBe(0);
  });

  it("replaces the same detector stream across runs instead of retaining old snapshots", () => {
    const tree = [{ dependencies: { app: { version: "1.0.0" } } }];
    const first = generate(tree);
    const second = generate(tree, { GITHUB_RUN_ID: "456", GITHUB_RUN_ATTEMPT: "2", GITHUB_SHA: "b".repeat(40) });
    expect(second.job.correlator).toBe(first.job.correlator);
    expect(second.job.id).not.toBe(first.job.id);
    expect(second.sha).toBe("b".repeat(40));
  });

  it("does not overwrite an already prepared snapshot", () => {
    const run = invoke([{ dependencies: { app: { version: "1.0.0" } } }]);
    expect(run.result.status, run.result.stderr).toBe(0);
    const original = readFileSync(run.output, "utf8");
    const repeated = spawnSync(process.execPath, [script, run.input, run.output], { env: run.env });
    expect(repeated.status).not.toBe(0);
    expect(readFileSync(run.output, "utf8")).toBe(original);
  });
});
