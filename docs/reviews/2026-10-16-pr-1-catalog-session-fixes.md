# PR #1: native command scope and repeatable conversation titles

All three Codex comments were verified against the installed `openclaw@2026.7.1-2` implementation before changing the adapter. Shared Gateway schemas and their pinned commit are unchanged.

- **4289836412 — command agent routing:** The native `commands.list` handler resolves a missing `agentId` to the host default. Its command builder discovers skills for that selected agent's workspace. The adapter now calls the public runtime route resolver with the active channel account/config and passes the resulting `agentId` to `commands.list`.
- **4289836420 — command provider visibility:** Native `pluginCommandSupportsChannel` treats an omitted provider as matching every plugin command. The adapter now passes `OPENCLAW_CHANNEL_ID` as `provider`, so OpenClaw filters commands restricted to another channel. This is verified with a real plugin command registration restricted to Telegram, a Gateway-only registration, and an unrestricted registration.
- **4289836422 — repeated titles:** Native session patching rejects a label already used by another session. Gateway display titles are not unique identities. The adapter no longer passes a title as `sessions.create.label`; independent session keys and local Gateway titles remain intact.

## Regression evidence

`test/host-catalog-routing.test.ts` invokes the pinned package's actual `commandsHandlers`, live plugin command registry, route resolver, and `createGatewaySession`. Native internal entrypoints are used only by these version-specific tests; production continues to use public runtime APIs.

Before the implementation fix, all three new source tests failed: the alternate workspace skill was missing, the Telegram-only command was exposed, and creating the second same-title session failed. After the fix, all three passed. The existing host workflow suite also passed with the updated native request arguments.

The same-title regression inspects the real native session store to confirm distinct session IDs, no unique labels, preserved Gateway titles, and an idempotent replay without an extra native creation.

## Deployment

Rebuild/reinstall the plugin and restart its OpenClaw host. The main repository's OpenClaw plugin commit pin must be advanced to this repair commit. No Android or shared-contract changes are needed for these three fixes.

## Validation results

- Source implementation: full serial suite passed, 34 files / 155 tests (`npm test -- --maxWorkers=1`).
- After rebuilding, the native regression suite ran against both TypeScript source and checked-in compiled runtime: 6 / 6 tests passed. These include the same native skill discovery, provider filtering, and duplicate-title storage checks.
- `npm run typecheck` passed, including the source/runtime regression matrix.
- `npm run build` passed; source/runtime contract bytes remain identical at `sha256:59244afa522108614123e4d047a8ff51f6f2e2651e9b800bb8c63e5e6e82d320`.
- Contract snapshot check passed against existing commit `4dd825ad3ae6ad20019ff38f6ff5c4f1a8708394` using `OPEN_ANDROID_GATEWAY_CONTRACT_ROOT=/workspace/open-android-intelligence/gateway-contract npm run contract:check`.
- `git diff --check` passed.
