import { Context } from "@deepseek-ai/cordis";
import LocalJobRegistry from "@deepseek-ai/dsh-jobs-local";
import { expect, it } from "vitest";
import { createJobProgressSource } from "../../src/jobs/progress-source.js";

it("delivers the latest content-free progress through the DSH output ring at settlement", async () => {
  const ctx = new Context();
  await ctx.plugin(LocalJobRegistry);
  ctx.jobs.attachController("progress-test");
  let finish!: (value: { status: "completed" }) => void;
  let progress = '{"stage":"transcribing"}';
  const done = new Promise<{ status: "completed" }>(resolve => { finish = resolve; });
  try {
    const id = ctx.jobs.start({ kind: "meeting", label: "Progress",
      output: [createJobProgressSource(() => progress)],
      run: () => ({ done, cancel: () => finish({ status: "completed" }) }),
    });
    progress = '{"stage":"cleaning"}';
    finish({ status: "completed" });
    await ctx.jobs.wait(id, 2_000);
    expect(ctx.jobs.read(id).chunks.at(-1)?.text).toBe('{"stage":"cleaning"}');
  } finally { await ctx.fiber.dispose(); }
});
