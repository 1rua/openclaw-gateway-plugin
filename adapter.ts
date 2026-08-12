import {
  createFakeAdapter,
  FROZEN_PROVIDER_TOOLS,
  type AdapterOptions,
  type AdapterProfile,
  type FakeAdapter,
} from "../shared/adapter.js";

export const OPENCLAW_PLUGIN_MANIFEST = Object.freeze({
  backend: "openclaw",
  upstream: Object.freeze({ release: "locked-fixture", tag: "openclaw-fixture-v1", commit: "fixture" }),
  protocolVersion: "mobile-bridge-v1",
  capabilitySchemaHash: "fixture-capability-schema-v1",
  authoritativeProfiles: Object.freeze({ chat: "gateway", tool: "plugin", event: "plugin-hook" }),
  profiles: Object.freeze([
    Object.freeze({ kind: "chat", id: "gateway", authoritative: true }),
    Object.freeze({ kind: "tool", id: "plugin", authoritative: true }),
    Object.freeze({ kind: "event", id: "plugin-hook", authoritative: true }),
  ] as const),
  zeroRetention: Object.freeze({ required: true, profileId: "fixture-zero-retention-v1", providerObjectRetention: "none", bodyEgress: "fail_closed" }),
  tools: FROZEN_PROVIDER_TOOLS,
});

export type OpenClawAdapterOptions = Omit<AdapterOptions, "profiles"> & Readonly<{ profiles?: readonly AdapterProfile[] }>;

export const createOpenClawAdapter = (options: OpenClawAdapterOptions): FakeAdapter => createFakeAdapter({
  ...options,
  zeroRetentionProfileId: OPENCLAW_PLUGIN_MANIFEST.zeroRetention.profileId,
  profiles: options.profiles === undefined ? OPENCLAW_PLUGIN_MANIFEST.profiles : options.profiles,
});
