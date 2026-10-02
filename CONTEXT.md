# Domain vocabulary

- **Meeting**: the plugin's persistent audio/transcript identity. It is independent
  of DSH sessions and workspaces.
- **Meeting reference**: an explicit stable meeting ID in one DSH message. It does
  not bind a session to a meeting or copy meeting facts.
- **Meeting audio**: original or normalized managed audio belonging to a meeting.
- **Recording track**: microphone or system-audio input on a shared meeting timeline;
  a track is neither a speaker nor an output channel.
- **Meeting speaker**: a voice identity distinguished within one meeting. It does
  not identify a real person or establish cross-meeting identity.
- **Draft transcript / revision**: provisional text and its current replaceable
  snapshot during a recording. It is distinct from a committed transcript version.
- **Committed transcript / version**: the accepted persistent meeting result.
- **Transcript projection**: a deterministic representation of one fixed transcript
  version for Agent consumption or export, rather than an independent fact source.
- **Export**: a user-requested file derived from committed text. It remains the
  user's asset and never updates the source meeting.
- **Transcription run**: one import or retranscription attempt and its immutable
  processing identity, distinct from the persistent meeting.
- **Recording session**: one start-to-stop/cancel/failure lifecycle with track state
  and temporary draft, distinct from a DSH session.
- **DSH session / workspace**: host-owned Agent conversation and workspace context;
  neither owns the plugin's meeting collection.
- **DSH job**: host-owned live observation/cancellation handle for background work.
- **Model pack**: a byte-verified base or optional punctuation archive installed
  under the plugin's DSH data root, with fixed compatibility and legal material.
- **Processing identity**: mode, selected model fingerprints, compatibility and
  engine identity captured at attempt start and retained with committed results.
