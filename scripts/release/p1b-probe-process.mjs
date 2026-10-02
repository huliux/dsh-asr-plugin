import { spawn } from "node:child_process";

const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const activeGroups = new Set();

export class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function appendBounded(previous, chunk) {
  if (previous.length >= MAX_CAPTURE_BYTES) return previous;
  return `${previous}${chunk.toString("utf8")}`.slice(0, MAX_CAPTURE_BYTES);
}

async function processRssBytes(pid) {
  const child = spawn("/bin/ps", ["-o", "rss=", "-g", String(pid)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk.toString("utf8"); });
  await new Promise((finish) => child.once("exit", finish));
  const kib = output.trim().split("\n")
    .map((value) => Number(value.trim()))
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);
  return kib * 1024;
}

function trackProcess(child) {
  if (child.pid !== undefined) activeGroups.add(child.pid);
  const forget = () => { if (child.pid !== undefined) activeGroups.delete(child.pid); };
  child.once("error", forget);
  child.once("exit", forget);
}

export function terminateActiveProcessGroups() {
  for (const pid of activeGroups) {
    try { process.kill(-pid, "SIGTERM"); } catch {}
  }
  const forced = setTimeout(() => {
    for (const pid of activeGroups) {
      try { process.kill(-pid, "SIGKILL"); } catch {}
    }
  }, 10_000);
  forced.unref();
}

function signalProcessGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch {}
}

export async function stopProcessTree(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((finish) => child.once("exit", finish));
  signalProcessGroup(child, "SIGTERM");
  await Promise.race([exited, new Promise((finish) => setTimeout(finish, 10_000))]);
  if (child.exitCode === null) {
    signalProcessGroup(child, "SIGKILL");
    await exited;
  }
}

function startInterruption(child, options) {
  const signal = options.interruptSignal ?? "SIGTERM";
  let failure;
  if (options.interruptAfterMs !== undefined) {
    const timer = setTimeout(() => signalProcessGroup(child, signal), options.interruptAfterMs);
    timer.unref();
    return { failure: () => failure, stop: () => clearTimeout(timer) };
  }
  if (options.interruptWhen === undefined) {
    return { failure: () => failure, stop: () => {} };
  }
  let stopped = false;
  let timer;
  const poll = async () => {
    if (stopped) return;
    let shouldInterrupt = false;
    try {
      shouldInterrupt = await options.interruptWhen();
    } catch (error) {
      failure = error instanceof ProbeFailure
        ? error
        : new ProbeFailure("INTERRUPT_CONDITION_FAILED");
      signalProcessGroup(child, "SIGKILL");
      return;
    }
    if (stopped) return;
    if (shouldInterrupt) {
      signalProcessGroup(child, signal);
      return;
    }
    timer = setTimeout(poll, 20);
    timer.unref();
  };
  timer = setTimeout(poll, 0);
  timer.unref();
  return {
    failure: () => failure,
    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

function startDeadline(child, timeoutMs) {
  const timeout = setTimeout(() => signalProcessGroup(child, "SIGTERM"), timeoutMs);
  const forced = setTimeout(() => signalProcessGroup(child, "SIGKILL"), timeoutMs + 10_000);
  timeout.unref();
  forced.unref();
  return () => {
    clearTimeout(timeout);
    clearTimeout(forced);
  };
}

export async function runCommand(command, args, options = {}) {
  const started = performance.now();
  const child = spawn(command, args, {
    cwd: options.cwd ?? options.workspace,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackProcess(child);
  let stdout = "";
  let stderr = "";
  let maxRssBytes = 0;
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  const sampler = setInterval(async () => {
    maxRssBytes = Math.max(maxRssBytes, await processRssBytes(child.pid));
  }, 100);
  sampler.unref();
  const timeoutMs = options.timeoutMs ?? 120_000;
  const stopDeadline = startDeadline(child, timeoutMs);
  const interruption = startInterruption(child, options);
  let outcome;
  try {
    outcome = await new Promise((finish, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => finish({ code, signal }));
    });
  } finally {
    clearInterval(sampler);
    stopDeadline();
    interruption.stop();
  }
  const interruptionFailure = interruption.failure();
  if (interruptionFailure !== undefined) throw interruptionFailure;
  maxRssBytes = Math.max(maxRssBytes, await processRssBytes(child.pid));
  return { ...outcome, stdout, stderr, maxRssBytes, elapsedMs: Math.round(performance.now() - started) };
}

export async function runRequired(command, args, options, errorCode) {
  const result = await runCommand(command, args, options);
  if (result.code !== 0) throw new ProbeFailure(errorCode);
  return result;
}

export function parseJsonLine(output, errorCode) {
  const lines = output.trim().split("\n").filter(Boolean);
  try {
    return JSON.parse(lines.at(-1) ?? "");
  } catch {
    throw new ProbeFailure(errorCode);
  }
}

export async function startObservedCommand(command, args, options, readyPattern) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? options.workspace,
    env: options.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  trackProcess(child);
  let output = "";
  let readySettled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const consume = (chunk) => {
    output = appendBounded(output, chunk);
    if (!readySettled && readyPattern.test(output)) {
      readySettled = true;
      resolveReady();
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", consume);
  const timeout = setTimeout(() => {
    if (!readySettled) rejectReady(new ProbeFailure("OBSERVED_PROCESS_READY_TIMEOUT"));
    try { process.kill(-child.pid, "SIGTERM"); } catch {}
  }, options.timeoutMs ?? 120_000);
  timeout.unref();
  const done = new Promise((resolve, reject) => {
    child.once("error", (error) => {
      if (!readySettled) rejectReady(error);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (!readySettled) rejectReady(new ProbeFailure("OBSERVED_PROCESS_EXITED_EARLY"));
      resolve({ code, signal });
    });
  });
  await ready;
  return { child, done, output: () => output };
}
