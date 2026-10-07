import { execFileSync } from "node:child_process";

const QUALIFIED_CLANG = "Apple clang version 17.0.0 (clang-1700.3.19.1)";
const QUALIFIED_SDK = "26.0";
const DEFAULT_DEVELOPER_DIR = "/Library/Developer/CommandLineTools";

export function appleBuildEnvironment() {
  const env = { ...process.env,
    DEVELOPER_DIR: process.env.DEVELOPER_DIR || DEFAULT_DEVELOPER_DIR };
  delete env.SDKROOT;
  const clang = xcrun(["clang", "--version"], env).split("\n")[0];
  const sdk = xcrun(["--sdk", "macosx", "--show-sdk-version"], env);
  if (clang !== QUALIFIED_CLANG || sdk !== QUALIFIED_SDK) {
    throw new Error("Native builds require Apple clang 17.0.0 (clang-1700.3.19.1) " +
      "and macOS SDK 26.0. Install the qualified Command Line Tools or set " +
      "DEVELOPER_DIR to a matching toolchain; do not replace the pinned binary hashes.");
  }
  return { ...env,
    CC: xcrun(["--find", "clang"], env),
    CXX: xcrun(["--find", "clang++"], env),
    SDKROOT: xcrun(["--sdk", "macosx", "--show-sdk-path"], env),
  };
}

function xcrun(args, env) {
  try {
    return execFileSync("/usr/bin/xcrun", args, { env, encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"], timeout: 30_000 }).trim();
  } catch (cause) {
    throw new Error("Cannot inspect the qualified Apple toolchain. Install Command " +
      "Line Tools or set DEVELOPER_DIR to a matching installation.", { cause });
  }
}
