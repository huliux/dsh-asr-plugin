CREATE TABLE meetings (
  meeting_id          TEXT PRIMARY KEY,
  title               TEXT NOT NULL
                      CHECK (length(title) BETWEEN 1 AND 200),
  source_name         TEXT NOT NULL
                      CHECK (length(source_name) BETWEEN 1 AND 255),
  source_format       TEXT NOT NULL
                      CHECK (source_format IN ('wav', 'm4a', 'mp3')),
  source_size_bytes   INTEGER NOT NULL
                      CHECK (source_size_bytes BETWEEN 1 AND 524288000),
  source_sha256       TEXT
                      CHECK (
                        source_sha256 IS NULL OR
                        (length(source_sha256) = 64 AND
                         source_sha256 NOT GLOB '*[^0-9a-f]*')
                      ),
  duration_ms         INTEGER
                      CHECK (duration_ms IS NULL OR
                             duration_ms BETWEEN 0 AND 14400000),

  status              TEXT NOT NULL
                      CHECK (status IN (
                        'processing', 'completed', 'empty', 'partial',
                        'failed', 'cancelled', 'deleting'
                      )),
  committed_status    TEXT
                      CHECK (committed_status IN ('completed', 'empty', 'partial')),
  transcript_version  INTEGER NOT NULL DEFAULT 0
                      CHECK (transcript_version >= 0),
  result_reason       TEXT
                      CHECK (result_reason IS NULL OR length(result_reason) <= 100),
  engine_fingerprint  TEXT
                      CHECK (
                        engine_fingerprint IS NULL OR
                        (length(engine_fingerprint) = 64 AND
                         engine_fingerprint NOT GLOB '*[^0-9a-f]*')
                      ),

  active_run_id       TEXT
                      CHECK (active_run_id IS NULL OR
                             length(active_run_id) BETWEEN 1 AND 100),
  run_kind            TEXT
                      CHECK (run_kind IN ('import', 'retranscribe')),
  error_code          TEXT
                      CHECK (error_code IS NULL OR length(error_code) <= 100),
  error_stage         TEXT
                      CHECK (error_stage IS NULL OR length(error_stage) <= 100),

  created_at_ms       INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms       INTEGER NOT NULL
                      CHECK (updated_at_ms >= created_at_ms),

  CHECK (
    (committed_status IS NULL AND transcript_version = 0 AND
     engine_fingerprint IS NULL) OR
    (committed_status IS NOT NULL AND transcript_version >= 1 AND
     engine_fingerprint IS NOT NULL)
  ),
  CHECK (
    status NOT IN ('completed', 'empty', 'partial') OR
    status = committed_status
  ),
  CHECK (
    status <> 'processing' OR
    (active_run_id IS NOT NULL AND run_kind IS NOT NULL)
  ),
  CHECK (
    status = 'processing' OR
    (active_run_id IS NULL AND run_kind IS NULL)
  ),
  CHECK (
    status NOT IN ('failed', 'cancelled') OR error_code IS NOT NULL
  )
) STRICT;

CREATE UNIQUE INDEX idx_one_processing
ON meetings((1))
WHERE status = 'processing';

CREATE INDEX idx_meetings_recent
ON meetings(created_at_ms DESC, meeting_id DESC);

CREATE INDEX idx_meetings_status
ON meetings(status);

CREATE TABLE segments (
  segment_pk          INTEGER PRIMARY KEY,
  meeting_id          TEXT NOT NULL
                      REFERENCES meetings(meeting_id) ON DELETE CASCADE,
  transcript_version  INTEGER NOT NULL CHECK (transcript_version >= 1),
  seq                 INTEGER NOT NULL CHECK (seq >= 0),
  start_ms            INTEGER NOT NULL CHECK (start_ms >= 0),
  end_ms              INTEGER NOT NULL CHECK (end_ms >= start_ms),
  speaker_label       TEXT NOT NULL
                      CHECK (length(speaker_label) BETWEEN 1 AND 32),
  text                TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 20000),
  UNIQUE (meeting_id, transcript_version, seq)
) STRICT;

CREATE VIRTUAL TABLE segments_fts USING fts5(
  text,
  content = 'segments',
  content_rowid = 'segment_pk',
  tokenize = 'trigram'
);

CREATE TRIGGER segments_ai AFTER INSERT ON segments BEGIN
  INSERT INTO segments_fts(rowid, text) VALUES (new.segment_pk, new.text);
END;

CREATE TRIGGER segments_ad AFTER DELETE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text)
  VALUES ('delete', old.segment_pk, old.text);
END;

CREATE TRIGGER segments_au AFTER UPDATE ON segments BEGIN
  INSERT INTO segments_fts(segments_fts, rowid, text)
  VALUES ('delete', old.segment_pk, old.text);
  INSERT INTO segments_fts(rowid, text) VALUES (new.segment_pk, new.text);
END;

PRAGMA user_version = 1;
