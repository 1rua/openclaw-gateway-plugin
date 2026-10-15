# OpenClaw host workflow fixes

The adapter targets the installed `openclaw@2026.7.1-2` peer dependency. No host APIs or model behavior are simulated in production.

- Android M4A/AAC bytes remain an audio attachment with `audio/mp4`. Verified temporary files preserve a safe filename extension so multipart providers can identify M4A uploads. No local speech transcription is introduced.
- Each accepted Gateway generation becomes the SDK `replyOptions.runId`. Active cancellation aborts the SDK's actual `abortSignal` and waits for its runner to settle before confirming cancellation. Late delivery is discarded. If the HTTP wait times out, later runner settlement still emits a durable cancellation event. Recovered runs use `runtime.gateway.request("chat.abort", {sessionKey, runId})` and require the native abort receipt.
- Assistant message completion carries `generationId`; it does not finish the user turn. The user message status finishes only when `inbound.run` settles. Cancellation events are emitted once.
- POST `/v2/conversations` immediately invokes the real `sessions.create` method with a stable key and no `message`, `task`, or `/new`. Public SDK `buildAgentSessionKey` selects per-account/channel/peer scope so OpenClaw's default main DM scope cannot merge distinct Gateway conversations. Existing explicit history bindings are retained. Client IDs and request reservations preserve identity through failed host calls and retries.
- GET `/v2/commands` calls the actual `commands.list` registry on each request. OpenClaw owns built-in, plugin, skill and configuration visibility; the adapter maps this registry to the common Android catalog shape and hashes the returned content for `catalogVersion`.

## Host API evidence

Verified against the installed pinned package:

- `dist/types-C5Sz_b28.d.ts`: `GetReplyOptions` includes `runId`, `abortSignal`, `onAgentRunStart`.
- `dist/types-DaHgOqFX.d.ts`: `PluginRuntime.gateway.request`, `PluginRuntime.channel.inbound.run`; assembled turns accept `replyOptions` and the default runner awaits full settlement.
- `dist/sessions-UcKjjh_n.js`: `sessions.create` creates/adopts a keyed session; a run is started only when an initial message is supplied.
- `dist/commands-CM7DPbT8.js` and `dist/commands-list-result-3Y35QAOy.js`: `commands.list` uses runtime config and the live command registry, including skills and plugins.
- `dist/chat-pg-BxhF6.js`: `chat.abort` accepts `sessionKey` and optional `runId`, and responds with an explicit `aborted` receipt.

## Validation

`test/host-workflows.test.ts` executes the real pinned SDK inbound runner, context builder, media normalizer and route resolver. It covers audio-only M4A byte/MIME/extension preservation; multiple assistant messages before terminal settlement; actual SDK abort signaling with late-delivery suppression; keyed host session creation and failed-call retries; live registry refresh; recovered run-scoped abort receipt. Native RPC boundaries are stubbed in these tests; they do not contact a running model or gateway server.

A coordinated Gateway contract update is required: the assistant completion schema allows `generationId`, and the command catalog uses the Android wire fields. The checked-in contract pin and generated runtime must be shipped together with the Android lifecycle fixes. Rebuild/reinstall the plugin for deployed hosts; updating the Android app alone cannot change host cancellation/session behavior.

Final local checks on 2026-10-15:

- `npm test -- --maxWorkers=1`: 33 files, 152 tests passed, including six host workflow integration tests and the existing streamed attachment/history suites.
- `npm run typecheck`: passed.
- `npm run build`: passed; checked-in `runtime/` regenerated, and source/runtime contract byte hashes both equal `sha256:59244afa522108614123e4d047a8ff51f6f2e2651e9b800bb8c63e5e6e82d320`.
- `OPEN_ANDROID_GATEWAY_CONTRACT_ROOT=/workspace/open-android-intelligence/gateway-contract npm run contract:check`: passed against existing commit `4dd825ad3ae6ad20019ff38f6ff5c4f1a8708394`.
- `git diff --check`: passed.

The session creation tests also cover an active nondefault channel account with a distinct configured agent binding. Shared vector validation retains its pinned fixture integrity check with the new message status schema digest. The native history fixture now records the session key supplied by the actual turn instead of assuming the host's default main session.
