const fingerprint = "0".repeat(64);

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length);
  return Buffer.concat([header, payload]);
}

process.stdout.write(frame({
  type: "ready",
  recording_protocol_version: 1,
  kind: "recording",
  engine_fingerprint: fingerprint,
  load_ms: 1,
}));
process.stdout.write(frame({
  type: "revision",
  revision: 1,
  base_revision: 0,
  replace_from_seq: 0,
  audio_through_ms: 1,
  generated_at_ms: 1,
  segments: [],
}));

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  if (input.length < 5 || input.readUInt32BE(0) !== input.length - 4) process.exit(2);
  const finalize = JSON.parse(input.subarray(4).toString("utf8"));
  process.stdout.end(frame({
    type: "final_result",
    request_id: finalize.request_id,
    base_transcript_version: finalize.base_transcript_version,
    engine_fingerprint: fingerprint,
    payload: {
      duration_ms: 0,
      source_size_bytes: 44,
      source_sha256: "1".repeat(64),
      result_status: "empty",
      result_reason: "silent",
      segments: [],
      audio_files: ["audio.tmp.wav"],
      metrics: {
        finalization_ms: 1,
        max_rss_bytes: 1,
        cache_hits: 0,
        cache_misses: 0,
      },
    },
  }));
});
