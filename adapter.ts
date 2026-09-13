import {
  createFakeAdapter,
  FROZEN_PROVIDER_TOOLS,
  type AdapterOptions,
  type AdapterProfile,
  type FakeAdapter,
} from "../shared/adapter.js";
import { coreSchemaHash } from "../../gateway-contract/src/core-schema-hash.js";
import {
  registerOpenAndroidIntelligenceGateway,
  composeGatewayServices,
  OPEN_ANDROID_INTELLIGENCE_CHANNEL,
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
  OPEN_ANDROID_INTELLIGENCE_CHANNEL,
  bindAdminService,
  composeGatewayServices,
  createAdminPanel,
  createAdminService,
  createGatewayExposure,
  createGatewayRoutes,
  gatewayRoutes,
  OPENCLAW_HOST_API,
  registerOpenAndroidIntelligenceGateway,
  runAdminCommand,
};
export type { AdminPanel, AdminResult, AdminService, OpenClawPluginApi };

export const OPENCLAW_PLUGIN_MANIFEST = Object.freeze({
  id: "open-android-intelligence-gateway",
  backend: "openclaw",
  upstream: Object.freeze({ release: "2026.7.1-2", tag: "v2026.7.1-2", commit: OPENCLAW_HOST_API.verifiedCommit }),
  protocolVersion: "gateway-protocol-v2",
  // The digest the phone compares during negotiation (contract §4), computed
  // from the checked-in Schema documents rather than named after them.
  capabilitySchemaHash: coreSchemaHash(),
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
  /**
   * Exactly what this implementation serves today.
   *
   * A host or operator reads this instead of inferring capability from the
   * contract: everything absent here is not implemented, and no field may claim
   * a control the code does not enforce.
   */
  capabilities: Object.freeze({
    negotiation: true,
    passwordLogin: true,
    refreshRotation: true,
    sessionLogout: true,
    commandCatalog: true,
    conversationRead: true,
    attachmentPolicy: true,
    /** Contract §9 server-sent events: this build answers `GET /events` with JSON. */
    sse: false,
    messageBatches: false,
    generationCancel: false,
    mirrorSync: false,
    invitationPairing: false,
    deviceKeySessions: false,
    /** Attachment bytes, event payloads and device-request parameters are not encrypted at rest. */
    encryptionAtRest: false,
  }),
  tools: FROZEN_PROVIDER_TOOLS,
  exposureModes: Object.freeze(["host-route", "loopback-reverse-proxy", "direct-tls"] as const),
  management: Object.freeze({ surface: "host-ui-and-local-cli", localOnly: true, remotePort: null, sensitiveOperations: "local-confirmation" }),
  securityBoundary: Object.freeze({
    rawHeaders: "delegated-to-verified-request-seam",
    // The host supplies the verifier; the core exposes the device key and the
    // pairing/grant revisions a verifier needs through `SessionService.resolveSession`.
    ed25519: "host-supplied-verifier",
    transport: "host-or-explicit-terminator",
    encryptionAtRest: "not-implemented",
    zeroRetention: "not-implemented",
  }),
});

export type OpenClawAdapterOptions = Omit<AdapterOptions, "profiles"> & Readonly<{ profiles?: readonly AdapterProfile[] }>;

export const createOpenClawAdapter = (options: OpenClawAdapterOptions): FakeAdapter =>
  // No zero-retention profile is bound here: this backend does not implement
  // one, and the manifest says so instead of naming a profile that would have to
  // be trusted rather than checked.
  createFakeAdapter({
    ...options,
    profiles: options.profiles === undefined ? OPENCLAW_PLUGIN_MANIFEST.profiles : options.profiles,
  });

export const OPENCLAW_PLUGIN = Object.freeze({
  id: "open-android-intelligence-gateway",
  name: "Open Android Intelligence Gateway",
  description: "Open Android Intelligence Gateway Protocol v2 channel and management adapter",
  register: registerOpenAndroidIntelligenceGateway,
});

export default OPENCLAW_PLUGIN;
