# PR #1: pending cancellation and abort availability follow-up

Addresses review comments 4292356013, 4292356022, and 4292356031 without changing the shared contract, snapshot hash, or pin.

## Findings and implementation

- Cancellation history filtering previously required the final `cancelled` state. While the runner was still settling, another account handle could read a late native assistant row. Filtering now also applies to running/unknown generations with a persisted cancellation request. The metadata survives independent readers, restart, and `OUTCOME_UNKNOWN` retries.
- Cancellation previously parsed the entire native transcript before signalling the runner. Invalid or unavailable history could prevent abort entirely, and long histories delayed the signal. The adapter now captures only the native session identity, device/inode identity, and file byte length before signalling. It never scans the transcript on the abort path; bookkeeping exceptions cannot block abort. Run-start and successful assistant-delivery callbacks retain a trusted checkpoint for store/stat failure.
- Ordinary history reads identify assistant rows by native session ID, opened-file identity, and exact UTF-8 line-end offsets. Bytes appended after the pre-signal watermark are suppressed; prior identical text remains visible. The next actual SDK run-start captures a closing watermark, retaining previous-run late writes while allowing that next run's output. Existing ID-list boundaries remain supported. Native message bodies are never copied into cancellation metadata.
- `UNSUPPORTED` and `ALREADY_COMPLETED` remove the request and cancellation boundary unless the runner has already persisted a confirmed cancellation; that terminal fact takes priority over a late native response. Unsupported cancellation restores an active generation to running; a later supported attempt captures a fresh watermark and correlation. `OUTCOME_UNKNOWN` retains the original watermark and first request correlation because the signal may already have taken effect. Completed/failed generations do not activate filtering.
- Commands GET now treats absent, empty, or whitespace-only `languageCode` as `en`, preserving schema-valid catalog responses.

## Regression evidence

Before implementation, the inherited source/runtime boundary suite reproduced six failures across pending-history reads, damaged-history abort, and unsupported retries (10 controls passed). The final suite exercises the real pinned SDK `SessionManager` and inbound runner using controlled dispatchers. Added cases verify pending reads through another Gateway account handle, unreadable store JSON, malformed transcript JSON, temporarily missing transcript, restored history, UTF-8/CRLF offsets, unsupported retry, unknown-outcome retry across reopen, and original cancellation correlation.

Validation logs are under `docs/reviews/evidence/2026-10-16-pr-1-cancellation-followup/`. All commands use the project Node 24 wrapper and single-worker Vitest. No live model or external server is used by these tests. Deployment and main-repository pin updates are handled separately after this local commit.

Final checks:

- `npm test -- --maxWorkers=1`: **36 files / 180 tests passed** (`full-suite.txt`).
- Focused source/runtime and language tests: **2 files / 22 tests passed** (`source-runtime-regressions.txt`), including 18 source/runtime boundary cases.
- `npm run typecheck`: passed (`typecheck.txt`).
- `npm run build`: passed (`build.txt`); regenerated runtime is exercised by the same boundary scenarios.
- Contract snapshot check: passed against unchanged `4dd825ad3ae6ad20019ff38f6ff5c4f1a8708394` (`contract-check.txt`). Source/runtime contract hash remains `sha256:59244afa522108614123e4d047a8ff51f6f2e2651e9b800bb8c63e5e6e82d320`.
- `git diff --check`: passed (`diff-check.json`).
