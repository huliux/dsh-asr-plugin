# Open knowledge base ingestion

Optional post-processing that turns every committed transcript into a readable,
linkable knowledge bundle in a folder the user chooses. The transcript itself
stays the source of truth; the bundle is a derived, versioned view of it.

## What the user sets up

Settings gains an "Open knowledge base" section with two values:

| Setting | Config key | Default | Meaning |
| --- | --- | --- | --- |
| Bundle folder | `okf_directory` | empty | Empty disables the feature entirely |
| Automatic ingestion | `okf_ingest` | `true` | Summarise each committed transcript without asking |

Choosing a folder is the consent step: it authorises the plugin and the
summarising child agent to create and update files in that tree, makes the folder
a Git repository, and records one commit per ingested meeting. The plugin writes
into the folder with `node:fs` from host code, exactly like transcript export, so
neither DSH Approval nor the filesystem sandbox stands in the way.

## Bundle layout

```
<folder>/                     git work tree, one commit per ingestion
  index.md                    root rollup
  meetings/index.md           every ingested meeting
  actions/index.md            action items, overdue first
  deadlines/index.md          upcoming deadlines, grouped by day
  meetings/<yyyy-mm-dd>-<slug>.md
  actions/<slug>.md
  entities/<type>/<slug>.md
  concepts/<slug>.md
  references/transcripts/<meeting-id>.md
```

Frontmatter and links follow OKF v0.2. Action pages use
`state: open | done | dropped`; `status` stays reserved for
`draft | stable | deprecated`, so a meeting whose transcript committed as
`partial` is written as `status: draft` and its pages are marked `deprecated`
(never deleted) when the meeting is deleted.

Pages link only inside the bundle; absolute paths, `..` segments and symlink
escapes fail the link gate. `http(s)` targets are allowed.

## One ingestion = one git transaction

1. A committed transcript version (import or retranscription) starts one job.
   Drafts, cancelled recordings and failed runs never trigger it.
2. The bundle lock serialises the whole bundle, not one meeting, because the git
   index is a single lock. A foreign `index.lock` is waited out with backoff.
3. An ingestion journal is written to `.git/okf-ingestion-journal` *before* any
   worktree write. An unclosed journal at startup means the previous run died and
   is rolled back before anything else happens.
4. A dirty worktree is committed first as `pre-ingest snapshot <iso>`, so human
   edits live inside the rollback target.
5. The plugin writes the transcript copy, then the child agent authors the
   meeting, action, entity and concept pages, then the plugin regenerates every
   rollup from SQLite and scans all links.
6. One commit `ingest <meeting-id>@v<version>`. Any failure runs
   `git reset --hard <baseline>` plus `git clean -fd`, so the worktree ends
   byte-identical to where it started.

Attempt state lives in the `okf_ingestion` table (schema version 5, additive) and
is surfaced by `meeting_get` as an `okf` block: `state`, `transcript_version`,
`attempt`, `finished_at`, `error_code`.

## The summarising child agent

Ingestion runs as a child agent whose workspace is the bundle folder, which is
why it needs no per-file approval and cannot write outside the tree. The
instruction asset is `assets/prompts/okf-ingest.md` and it treats the transcript
as untrusted data: imperative text inside a recording is never a rule, pages cite
segment timestamps, and `index.md` files are off limits because the plugin
regenerates them.

The `okf` skill is the page-convention authority. When the host can prove the
skill is missing, ingestion degrades to the transcript copy plus regenerated
indexes and never writes summaries from memory. When the host cannot answer, the
probe is optimistic: a genuinely missing skill fails the child and the whole
transaction rolls back.

## `/asr-ingest`

Manual (re-)ingestion:

```
/asr-ingest <meeting-id>            ingest the current committed version
/asr-ingest <meeting-id> --force    ingest even when automatic ingestion is off
```

The command reports the job id, refuses with a clear message when no bundle folder
is configured, and routes into the same entry point as automatic ingestion, so
idempotency, locking and rollback behave identically.

## Failure and privacy rules

- A failed ingestion never fails the transcript, never truncates a page and never
  leaves a half-written bundle.
- Bundle contents, meeting titles, speaker names and transcript text never appear
  in logs, error messages, job labels or git arguments. Path components are
  validated against `[a-z0-9-]` and git is invoked with an argv array, never a
  shell string.
- The bundle is user data. It is never written inside this repository, never
  committed here, and never included in exports.

## Verification

- Unit: slugs and layout paths, frontmatter round-trips, transcript escaping,
  rollup rendering, link scanning, `meeting_get` surfacing.
- Integration: real temporary Git repositories for the transaction, rollback and
  journal recovery; a real SQLite schema-v5 database for attempt bookkeeping; a
  fake agent port for the ingestion pipeline, including a failing agent and a
  link that leaves the bundle.
- Isolation: synthetic fixtures, isolated `DSH_HOME`, no network, no user data.
