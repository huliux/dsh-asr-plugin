import { ProbeFailure } from "./p1b-probe-process.mjs";

export async function step(checks, id, action) {
  const started = performance.now();
  try {
    const result = await action();
    checks.push({ id, status: "passed", elapsed_ms: Math.round(performance.now() - started),
      ...(result?.maxRssBytes > 0 ? { max_rss_bytes: result.maxRssBytes } : {}) });
    return result;
  } catch (error) {
    checks.push({ id, status: "failed",
      error_code: error instanceof ProbeFailure ? error.code : "UNEXPECTED_FAILURE",
      elapsed_ms: Math.round(performance.now() - started) });
    throw error;
  }
}

export function pluginExec(...args) {
  return ["plugin", "--profile", "web", "exec", "dsh-asr-assets", ...args];
}
