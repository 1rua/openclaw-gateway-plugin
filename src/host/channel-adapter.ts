import { createGatewayCore, type GatewayCore } from "../core/gateway-core.js";
import {
  createAdminCliRegistrar,
  bindAdminService,
  type OpenClawCliRegistrar,
  type OpenClawCliRegistrationOptions,
} from "../admin/cli.js";
import {
  createAdminPanel,
  createAdminService,
  type AdminPanel,
  type AdminService,
} from "../admin/service.js";
import {
  createGatewayExposure,
  OPENCLAW_HOST_API,
  type ExposureMode,
  type GatewayExposure,
  type GatewayRequestVerifier,
  type HostApiCompatibility,
  type OpenClawPluginHttpRouteParams,
} from "../http/routes.js";

export type OpenClawChannelConfig = Readonly<{
  listAccountIds: (config: unknown) => string[];
  resolveAccount: (config: unknown, accountId?: string | null) => Readonly<{ accountId: string }>;
}>;

export type OpenClawOperatorScope =
  | "operator.admin"
  | "operator.read"
  | "operator.write"
  | "operator.approvals"
  | "operator.pairing"
  | "operator.talk.secrets";

export type OpenClawChannelPlugin = Readonly<{
  id: "open-android-intelligence-gateway";
  meta: Readonly<{
    id: "open-android-intelligence-gateway";
    label: "Open Android Intelligence Gateway";
    selectionLabel: "Open Android Intelligence Gateway";
    docsPath: "/gateway/open-android-intelligence";
    blurb: string;
  }>;
  capabilities: Readonly<{
    chatTypes: Array<"direct" | "thread">;
    media: boolean;
  }>;
  config: OpenClawChannelConfig;
  gatewayMethods: string[];
  gatewayMethodDescriptors: Array<Readonly<{
    name: string;
    scope?: OpenClawOperatorScope;
    description?: string;
  }>>;
}>;

export const OPEN_ANDROID_INTELLIGENCE_CHANNEL: OpenClawChannelPlugin = Object.freeze({
  id: "open-android-intelligence-gateway" as const,
  meta: Object.freeze({
    id: "open-android-intelligence-gateway" as const,
    label: "Open Android Intelligence Gateway" as const,
    selectionLabel: "Open Android Intelligence Gateway" as const,
    docsPath: "/gateway/open-android-intelligence" as const,
    blurb: "Gateway Protocol v2 over the OpenClaw Gateway host",
  }),
  capabilities: {
    chatTypes: ["direct" as const],
    media: true,
  },
  config: {
    listAccountIds: (_config: unknown): string[] => [],
    resolveAccount: (_config: unknown, accountId?: string | null): Readonly<{ accountId: string }> => ({
      accountId: accountId ?? "default",
    }),
  },
  // Management is deliberately exposed through the host's local panel and
  // CLI, so no remote gateway method is advertised or registered here.
  gatewayMethods: [],
  gatewayMethodDescriptors: [],
});

export type OpenClawChannelRegistration = Readonly<{
  plugin: OpenClawChannelPlugin;
}>;

export type OpenClawGatewayMethodHandlerOptions = Readonly<{
  req: unknown;
  params: Record<string, unknown>;
  client: unknown | null;
  isWebchatConnect: (params: unknown) => boolean;
  respond: (...args: unknown[]) => unknown;
  context: unknown;
}>;

export type OpenClawGatewayMethodHandler = (
  options: OpenClawGatewayMethodHandlerOptions,
) => Promise<void> | void;

export type OpenClawPluginApi = Readonly<{
  registerChannel: (registration: OpenClawChannelRegistration | OpenClawChannelPlugin) => void;
  registerHttpRoute: (route: OpenClawPluginHttpRouteParams) => void;
  registerAdminPanel?: (panel: AdminPanel) => void;
  /** Typed for host compatibility; intentionally not used for management. */
  registerGatewayMethod?: (
    name: string,
    handler: OpenClawGatewayMethodHandler,
    options?: Readonly<{ scope?: OpenClawOperatorScope }>,
  ) => void;
  registerCli?: (registrar: OpenClawCliRegistrar, options?: OpenClawCliRegistrationOptions) => void;
  /** Explicit security-layer seam; absent means every raw route is 401. */
  verifyRequest?: GatewayRequestVerifier;
  maxBodyBytes?: number;
  version?: string;
  hostVersion?: string;
  dataDir?: string;
  resolvePath?: (input: string) => string;
  gatewayCore?: GatewayCore;
  runtime?: Readonly<{
    dataDir?: string;
    gatewayCore?: GatewayCore;
    verifyRequest?: GatewayRequestVerifier;
  }>;
  pluginConfig?: Readonly<Record<string, unknown>>;
}>;

export type GatewayServices = Readonly<{
  core: GatewayCore;
  admin: AdminService;
  adminPanel: AdminPanel;
  exposure: GatewayExposure;
}>;

export type ComposeGatewayServicesOptions = Readonly<{
  core?: GatewayCore;
  storageRoot?: string;
  hostVersion?: string;
  hostApi?: HostApiCompatibility;
  exposureMode?: ExposureMode;
  verifyRequest?: GatewayRequestVerifier;
  maxBodyBytes?: number;
}>;

const exposureMode = (value: unknown): ExposureMode => {
  if (value === "loopback-reverse-proxy" || value === "direct-tls") return value;
  return "host-route";
};

export const composeGatewayServices = (options: ComposeGatewayServicesOptions = {}): GatewayServices => {
  const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
  const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot });
  const admin = createAdminService({ core, hostVersion: options.hostVersion, hostApi });
  const exposure = createGatewayExposure(options.exposureMode ?? "host-route", {
    core,
    hostVersion: options.hostVersion,
    hostApi,
    verifyRequest: options.verifyRequest,
    maxBodyBytes: options.maxBodyBytes,
  });
  return Object.freeze({ core, admin, adminPanel: createAdminPanel(admin), exposure });
};

// OpenClaw's `api.version` is plugin metadata, not the host API version.
// Only an explicit trusted host-version adapter may enable this integration.
const apiHostVersion = (api: OpenClawPluginApi): string | undefined => api.hostVersion;

const apiStorageRoot = (api: OpenClawPluginApi): string | undefined =>
  api.dataDir
  ?? api.runtime?.dataDir
  ?? (api.resolvePath === undefined ? undefined : api.resolvePath(".open-android-intelligence-openclaw/accounts"));

const apiCore = (api: OpenClawPluginApi): GatewayCore | undefined =>
  api.gatewayCore ?? api.runtime?.gatewayCore;

const apiVerifier = (api: OpenClawPluginApi): GatewayRequestVerifier | undefined =>
  api.verifyRequest ?? api.runtime?.verifyRequest;

const apiExposureMode = (api: OpenClawPluginApi): ExposureMode =>
  exposureMode(api.pluginConfig?.exposureMode);

const registerManagementSurface = (api: OpenClawPluginApi, services: GatewayServices): void => {
  bindAdminService(services.admin);
  if (api.registerAdminPanel !== undefined) api.registerAdminPanel(services.adminPanel);
  if (api.registerCli !== undefined) {
    api.registerCli(createAdminCliRegistrar(services.admin), {
      parentPath: [],
      commands: ["open-android-intelligence"],
      descriptors: [{
        name: "open-android-intelligence",
        description: "Manage Open Android Intelligence Gateway accounts",
        hasSubcommands: true,
      }],
    });
  }
};

export const registerOpenAndroidIntelligenceGateway = (api: OpenClawPluginApi): void => {
  const services = composeGatewayServices({
    core: apiCore(api),
    storageRoot: apiStorageRoot(api),
    hostVersion: apiHostVersion(api),
    exposureMode: apiExposureMode(api),
    verifyRequest: apiVerifier(api),
    maxBodyBytes: api.maxBodyBytes,
  });
  api.registerChannel(Object.freeze({
    plugin: OPEN_ANDROID_INTELLIGENCE_CHANNEL,
  }));
  for (const route of services.exposure.routes) {
    api.registerHttpRoute({
      path: route.path,
      auth: route.auth,
      match: route.match,
      handler: route.handler,
    });
  }
  registerManagementSurface(api, services);
};
