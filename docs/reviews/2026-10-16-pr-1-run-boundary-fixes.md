# PR #1: persisted session ownership and cancellation boundaries

This follow-up addresses review IDs 4290090065, 4290090070, 4290090075, and 4290090080. It retains the earlier catalog/provider/title repairs. Shared schemas, hashes, and contract pins are unchanged.

## Reproduction and implementation

- **4290090065:** Reusing an old session key/store while retaining a newly resolved agent/account mixed two different host routes. Session bindings now persist the full agent/account/key/store tuple and reuse that tuple throughout SDK ingress, context construction, session recording, and dispatch. Legacy agent-scoped keys are interpreted with the pinned SDK's `parseAgentSessionKey`; per-account Gateway keys retain their encoded account. Unscoped legacy keys use the incoming channel account once and persist the recovered ownership. Invalid or contradictory agent identities fail instead of dispatching a mixed binding.
- **4290090075:** Discarding a late SSE callback did not remove its independently persisted native transcript entry. Before requesting an abort, the adapter now saves the native session ID and existing assistant entry IDs. Once cancellation is confirmed, history filters newly added assistant IDs for that native session. The next SDK `onAgentRunStart` closes the boundary with a persisted set of suppressed IDs. This uses the actual model-run start hook rather than the time the next Gateway turn enters the host queue. Identical older text, output completed before cancellation, subsequent legitimate runs, and a different native session remain visible. Completed/failed generations do not activate cancellation filtering.
- **4290090080:** Worker settlement could emit the deduplicated cancellation event first with a synthetic correlation ID. The initial authenticated cancellation correlation is now persisted before abort dispatch; both worker settlement and the HTTP outcome use that identity, including after an unknown outcome or restart.
- **4290090070:** The existing route only accepted `requestId`, while the published schema requires `clientMessageId`. The canonical body is now validated with `conversation.generationCancel`; its client ID is independent of the authenticated HTTP request ID. The exact legacy `{requestId}` body remains accepted only when it matches the authenticated request ID. Mixed/extra fields, malformed canonical IDs, mismatched legacy IDs, and mismatched idempotency headers are rejected. Idempotency hashing still uses the original request body.

The installed `openclaw@2026.7.1-2` SDK supplies the actual inbound runner, context builder, route parser/resolver, and `SessionManager` used by the regression tests. Its `agent-runner.runtime-DtdxZiBX.js` forwards the synchronous `onAgentRunStart` callback; its native session entry format provides stable message IDs but does not require a Gateway generation ID in every assistant row. The filter therefore stores native identities, not text or timestamp guesses. Message bodies remain in the native transcript.

## Validation

The new source tests initially reproduced all four findings (four failures); an additional already-completed control passed. After repair, all five passed. `test/host-turn-boundaries.test.ts` runs the same five scenarios against source and generated runtime, using the real SDK `SessionManager` to persist native JSONL. The model dispatcher is controlled at the SDK boundary; no live model or external server is required.

The history scenario verifies reopening Gateway storage, identical old/late assistant text, an additional native write after worker settlement, a prior-run write while the next turn waits in the host queue, a legitimate subsequent answer, and native session replacement. Other scenarios verify legacy owner recovery across reopen, exactly one event with the real HTTP correlation after replay, preservation of a genuinely completed answer, canonical client-ID independence, and legacy compatibility.

## Deployment

Rebuild/reinstall the plugin and restart the OpenClaw host. Advance the main repository plugin pin/lock to this follow-up commit. Existing Gateway bindings are enriched lazily; this does not require editing native history. No shared-schema migration is required.

Final checks:

- `npm test -- --maxWorkers=1`: 35 files / 168 tests passed, including the ten source/runtime boundary cases.
- `npm run typecheck`: passed.
- `npm run build`: passed; the checked-in runtime is regenerated and exercised by the same boundary tests.
- `OPEN_ANDROID_GATEWAY_CONTRACT_ROOT=/workspace/open-android-intelligence/gateway-contract npm run contract:check`: passed against unchanged commit `4dd825ad3ae6ad20019ff38f6ff5c4f1a8708394`.
- Source/runtime contract hashes remain `sha256:59244afa522108614123e4d047a8ff51f6f2e2651e9b800bb8c63e5e6e82d320`.
- `git diff --check`: passed.
