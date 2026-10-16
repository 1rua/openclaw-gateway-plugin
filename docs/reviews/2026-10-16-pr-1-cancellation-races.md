# PR #1: cancellation receipt race and unflushed native sessions

This narrowly extends the pending-cancellation repair after local review, before publication. Shared schemas, contract pin, and hash are unchanged.

## Runner settlement wins over a late host receipt

A pending native cancellation can return `UNSUPPORTED` or `ALREADY_COMPLETED` after the tracked runner has already called `completeCancellation`. Previously, `finishCancel` kept the terminal generation state but deleted its native-history boundary and request correlation. That resurrected late native assistant rows.

`finishCancel` now reloads the persisted generation and treats an already-confirmed `cancelled` state as `CANCELLED`, preserving the boundary and first authenticated cancellation correlation. The existing cancellation event remains deduplicated. A genuine unsupported/completed outcome still clears its speculative boundary when no runner-confirmed cancellation exists.

The new deferred-host-response regression first observes `unknown`, writes a late native row, invokes the same workflow completion used by runner-finally, and then releases each stale host outcome. It checks the returned cancellation receipt, reopening storage, suppression of late rows before and after the receipt, preservation of old history, and exactly one event with the original HTTP correlation. Both outcomes run against source and generated runtime.

## Native run-start does not imply a transcript file exists

The installed `openclaw@2026.7.1-2` SDK provides evidence that new native sessions may be admitted before their first transcript flush:

- `node_modules/openclaw/dist/session-manager-BC-U4J87.js:1509`: `newSession` creates in-memory entries, sets `flushed = false`, and assigns `sessionFile`; it does not create that file.
- `node_modules/openclaw/dist/agent-runner.runtime-DtdxZiBX.js:1847`: `notifyAgentRunStart` forwards the callback when execution-phase activity starts, without a transcript-existence guarantee.

The source/runtime regression creates a real SDK `SessionManager`, verifies its file does not exist, switches the native binding to that new session, and invokes `onAgentRunStart` before appending messages. The runner must complete and its subsequent normal assistant output must remain visible.

`beginHostTurn` now tolerates `ENOENT` while capturing the closing watermark. It closes the old cancellation boundary without blocking the new runner. The old boundary retains its native session/file identity, so a new session's subsequently flushed output is independent of that old cancellation.

## Validation

The new scenarios initially produced **6 failures / 18 passing controls** across source/runtime (`red.txt`). After the two source changes and runtime rebuild, all **24 source/runtime boundary cases passed** (`source-runtime-regressions.txt`). Logs are in `docs/reviews/evidence/2026-10-16-pr-1-cancellation-races/`.

Final checks:

- Full suite: **36 files / 186 tests passed** (`full-suite.txt`).
- Source/runtime boundary suite: **24 tests passed** (`source-runtime-regressions.txt`).
- Typecheck and runtime build: passed (`typecheck.txt`, `build.txt`).
- Contract check: passed against unchanged `4dd825ad3ae6ad20019ff38f6ff5c4f1a8708394` (`contract-check.txt`); runtime contract hash remains `sha256:59244afa522108614123e4d047a8ff51f6f2e2651e9b800bb8c63e5e6e82d320`.
- `git diff --check`: passed (`diff-check.json`).
