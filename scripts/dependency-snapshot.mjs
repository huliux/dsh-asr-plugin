import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Consume pnpm's complete lockfile view, including optional packages for other
// platforms. No install scripts, registry requests or credentials are needed.
const [input, output, ...extra] = process.argv.slice(2);
assert.ok(input && output && extra.length === 0,
  'usage: node scripts/dependency-snapshot.mjs tree.json /absolute/new-snapshot.json');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.ok(isAbsolute(output) && relative(root, output).startsWith(`..${sep}`),
  'Snapshot output must be outside the checkout');
const { GITHUB_SHA: sha, GITHUB_REF: ref, GITHUB_RUN_ID: runId,
  GITHUB_REPOSITORY: repository, GITHUB_RUN_ATTEMPT: attempt = '1' } = process.env;
assert.match(sha ?? '', /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
assert.equal(ref, 'refs/heads/main', 'Only the default branch may publish this snapshot');
assert.match(runId ?? '', /^\d+$/);
assert.match(attempt, /^\d+$/);
assert.match(repository ?? '', /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

const projects = JSON.parse(await readFile(input, 'utf8'));
assert.ok(Array.isArray(projects) && projects.length > 0, 'Missing pnpm projects');
const graph = new Map();
const direct = new Set();
const runtimeRoots = new Set();
const categories = ['dependencies', 'devDependencies', 'optionalDependencies'];

function visit(alias, dependency) {
  assert.ok(dependency && typeof dependency === 'object', 'Missing dependency');
  const name = dependency.name ?? dependency.from ?? alias;
  const version = dependency.version;
  assert.match(name, /^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/,
    'Unsupported dependency name');
  assert.match(version ?? '', /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/,
    'Dependency must have a resolved npm version');
  const id = `pkg:npm/${name.split('/').map(encodeURIComponent).join('/')}@${encodeURIComponent(version)}`;
  let node = graph.get(id);
  if (!node) {
    node = { children: new Set() };
    graph.set(id, node);
  }
  // pnpm may expand a package only at one occurrence and mark others deduped.
  // Merge all occurrences before assigning scopes, rather than dropping edges.
  for (const category of categories) {
    for (const [childAlias, child] of Object.entries(dependency[category] ?? {})) {
      node.children.add(visit(childAlias, child));
    }
  }
  return id;
}

for (const project of projects) {
  for (const category of categories) {
    for (const [alias, dependency] of Object.entries(project[category] ?? {})) {
      const id = visit(alias, dependency);
      direct.add(id);
      if (category !== 'devDependencies') runtimeRoots.add(id);
    }
  }
}
assert.ok(graph.size > 0 && direct.size > 0, 'Refusing an empty dependency snapshot');
const runtime = new Set();
const pending = [...runtimeRoots];
while (pending.length > 0) {
  const id = pending.pop();
  if (runtime.has(id)) continue;
  runtime.add(id);
  pending.push(...graph.get(id).children);
}
const resolved = Object.fromEntries([...graph].sort(([a], [b]) => a.localeCompare(b))
  .map(([id, node]) => [id, {
    package_url: id,
    relationship: direct.has(id) ? 'direct' : 'indirect',
    scope: runtime.has(id) ? 'runtime' : 'development',
    dependencies: [...node.children].sort(),
  }]));
const snapshot = {
  version: 0,
  sha,
  ref,
  job: {
    id: `${runId}/${attempt}`,
    correlator: 'pnpm-lockfile/main',
    html_url: `https://github.com/${repository}/actions/runs/${runId}`,
  },
  detector: {
    name: 'dsh-pnpm-lockfile',
    version: '1.0.0',
    url: `https://github.com/${repository}/blob/main/scripts/dependency-snapshot.mjs`,
  },
  scanned: new Date().toISOString(),
  manifests: {
    'pnpm-lock.yaml': {
      name: 'pnpm-lock.yaml',
      file: { source_location: 'pnpm-lock.yaml' },
      resolved,
    },
  },
};
await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ dependencies: graph.size, runtime: runtime.size,
  development: graph.size - runtime.size }));
