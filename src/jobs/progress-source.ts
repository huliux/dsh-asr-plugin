import type { JobOutputSource } from "@deepseek-ai/dsh-jobs";

export function createJobProgressSource(snapshot: () => string): JobOutputSource {
  let text = "";
  let start = 0;
  let total = 0;
  return {
    read(from) {
      const next = snapshot();
      if (next !== "" && next !== text) {
        start = total;
        text = next;
        total += Buffer.byteLength(text);
      }
      return { text: from < total ? text : "", nextOffset: total, lossy: from < start };
    },
  };
}
