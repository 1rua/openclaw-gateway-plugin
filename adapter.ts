import {
  createFakeAdapter,
  FROZEN_PROVIDER_TOOLS,
  type AdapterOptions,
  type AdapterProfile,
  type FakeAdapter,
} from "../shared/adapter.js";
import {
  registerAgentLifeGateway,
  composeGatewayServices,
  AGENT_LIFE_CHANNEL,
  type OpenClawPluginApi,
} from "./src/host/channel-adapter.js";
import {
  createAdminPanel,
  createAdminService,
  type AdminPanel,
  type AdminResult,
  type AdminService,
} from "./src/admin/service.js";
import { bindAdminService, runAdminCommand } from "./src/admin/cli.js";
import {
  createGatewayExposure,
  createGatewayRoutes,
  gatewayRoutes,
  OPENCLAW_HOST_API,
} from "./src/http/routes.js";

export {
  AGENT_LIFE_CHANNEL,
  bindAdminService,
  composeGatewayServices,
  createAdminPanel,
  createAdminService,
  createGatewayExposure,
  createGatewayRoutes,
  gatewayRoutes,
  OPENCLAW_HOST_API,
  registerAgentLifeGateway,
  runAdminCommand,
};
export type { AdminPanel, AdminResult, AdminService, OpenClawPluginApi };

export const OPENCLAW_PLUGIN_MANIFEST = Object.freeze({
  id: "agent-life-gateway",
  backend: "openclaw",
  upstream: Object.freeze({ release: "2026.7.1-2", tag: "v2026.7.1-2", commit: OPENCLAW_HOST_API.verifiedCommit }),
  protocolVersion: "gateway-protocol-v2",
  capabilitySchemaHash: "gateway-protocol-v2",
  hostApi: Object.freeze({
    min: OPENCLAW_HOST_API.minVersion,
    max: OPENCLAW_HOST_API.maxVersion,
    commit: OPENCLAW_HOST_API.verifiedCommit,
  }),
  authoritativeProfiles: Object.freeze({ chat: "gateway", tool: "plugin", event: "plugin-hook" }),
  profiles: Object.freeze([
    Object.freeze({ kind: "chat", id: "gateway", authoritative: true }),
    Object.freeze({ kind: "tool", id: "plugin", authoritative: true }),
    Object.freeze({ kind: "event", id: "plugin-hook", authoritative: true }),
  ] as const),
  zeroRetention: Object.freeze({ required: true, profileId: "openclaw-zero-retention-v2", providerObjectRetention: "none", bodyEgress: "fail_closed" }),
  tools: FROZEN_PROVIDER_TOOLS,
  exposureModes: Object.freeze(["host-route", "loopback-reverse-proxy", "direct-tls"] as const),
  management: Object.freeze({ surface: "host-ui-and-local-cli", localOnly: true, remotePort: null, sensitiveOperations: "local-confirmation" }),
  securityBoundary: Object.freeze({
    rawHeaders: "delegated-to-verified-request-seam",
    ed25519: "not-implemented-in-task-4",
    tls: "host-or-explicit-terminator",
  }),
});

export type OpenClawAdapterOptions = Omit<AdapterOptions, "profiles"> & Readonly<{ profiles?: readonly AdapterProfile[] }>;

export const createOpenClawAdapter = (options: OpenClawAdapterOptions): FakeAdapter => {
  const profileBinding = options.zeroRetention?.profileId === OPENCLAW_PLUGIN_MANIFEST.zeroRetention.profileId
    ? { zeroRetentionProfileId: OPENCLAW_PLUGIN_MANIFEST.zeroRetention.profileId }
    : {};
  return createFakeAdapter({
    ...options,
    ...profileBinding,
    profiles: options.profiles === undefined ? OPENCLAW_PLUGIN_MANIFEST.profiles : options.profiles,
  });
};

export const OPENCLAW_PLUGIN = Object.freeze({
  id: "agent-life-gateway",
  name: "Agent-life Gateway",
  description: "Agent-life Gateway Protocol v2 channel and management adapter",
  register: registerAgentLifeGateway,
});

export default OPENCLAW_PLUGIN;
