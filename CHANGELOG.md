# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0]

### First public release

- Narrative-preserving, incremental context garbage collection for Pi.
- Runs once per session (before the first LLM call), adapting aggressiveness to
  context-window usage.
- Tiers:
  - **Tier 1** — remove exact duplicate tool output.
  - **Tier 2** — invalidate older reads of edited files + collapse oversized one-off
    tool outputs (head + tail, middle replaced with a placeholder).
  - **Tier 3** — dedup short, identical bash outputs.
- Non-destructive by design: never touches user/assistant narrative, recent turns,
  your files, or the persisted session. Runs on a deep clone.
- Secret redaction in place (JWTs, AWS keys, hex/base64 blobs, generic API keys)
  with a quarantined JSONL log for review.
- Configurable via env (`CONTEXT_GC_NO_LOG`) and tunable constants; log/quarantine
  rotation.
- 24 passing tests, strict typecheck, and CI.
