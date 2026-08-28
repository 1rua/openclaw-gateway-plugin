import { createGatewayCore, type GatewayCore } from "../core/gateway-core.js";
import { createAdminCliRegistrar, bindAdminService, type OpenClawCliContext } from "../admin/cli.js";
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
  type HostApiCompatibility,
  type OpenClawHttpRouteRegistration,
} from "../http/routes.js";

export type OpenClawChannelPlugin = Readonly<{
  id: "agent-life-gateway";
  meta: Readonly<{
    id: "agent-life-gateway";
    label: "Agent-life Gateway";
    blurb: string;
  }>;
}>;

export const AGENT_LIFE_CHANNEL: OpenClawChannelPlugin = Object.freeze({
  id: "agent-life-gateway" as const,
  meta: Object.freeze({
    id: "agent-life-gateway" as const,
    label: "Agent-life Gateway" as const,
    blurb: "Gateway Protocol v2 over the OpenClaw Gateway host",
  }),
});

export type OpenClawChannelRegistration = Readonly<{
  plugin: OpenClawChannelPlugin;
}>;

export type OpenClawCliRegistrar = (
  context: OpenClawCliContext | readonly string[],
) => Promise<unknown>;

export type OpenClawPluginApi = Readonly<{
  registerChannel: (registration: OpenClawChannelRegistration) => void;
  registerHttpRoute: (route: OpenClawHttpRouteRegistration) => void;
  registerAdminPanel?: (panel: AdminPanel) => void;
  registerGatewayMethod?: (name: string, handler: (params: unknown) => Promise<unknown>) => void;
  registerCli?: (registrar: OpenClawCliRegistrar, options?: Readonly<Record<string, unknown>>) => void;
  version?: string;
  hostVersion?: string;
  dataDir?: string;
  resolvePath?: (input: string) => string;
  gatewayCore?: GatewayCore;
  runtime?: Readonly<{
    version?: string;
    dataDir?: string;
    gatewayCore?: GatewayCore;
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
}>;

const exposureMode = (value: unknown): ExposureMode => {
  if (value === "loopback-reverse-proxy" || value === "direct-tls") return value;
  return "host-route";
};

export const composeGatewayServices = (options: ComposeGatewayServicesOptions = {}): GatewayServices => {
  const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
  const hostVersion = options.hostVersion ?? hostApi.maxVersion;
  const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot });
  const admin = createAdminService({ core, hostVersion, hostApi });
  const exposure = createGatewayExposure(options.exposureMode ?? "host-route", { core, hostVersion, hostApi });
  return Object.freeze({ core, admin, adminPanel: createAdminPanel(admin), exposure });
};

const apiHostVersion = (api: OpenClawPluginApi): string =>
  api.hostVersion ?? api.runtime?.version ?? api.version ?? OPENCLAW_HOST_API.maxVersion;

const apiStorageRoot = (api: OpenClawPluginApi): string | undefined =>
  api.dataDir
  ?? api.runtime?.dataDir
  ?? (api.resolvePath === undefined ? undefined : api.resolvePath(".agent-life-openclaw/accounts"));

const apiCore = (api: OpenClawPluginApi): GatewayCore | undefined =>
  api.gatewayCore ?? api.runtime?.gatewayCore;

const apiExposureMode = (api: OpenClawPluginApi): ExposureMode =>
  exposureMode(api.pluginConfig?.exposureMode);

const registerManagementSurface = (api: OpenClawPluginApi, services: GatewayServices): void => {
  bindAdminService(services.admin);
  if (api.registerAdminPanel !== undefined) {
    api.registerAdminPanel(services.adminPanel);
  } else if (api.registerGatewayMethod !== undefined) {
    api.registerGatewayMethod("agent-life.admin", async (params) => {
      if (Array.isArray(params)) {
        const registrar = createAdminCliRegistrar(services.admin);
        return registrar(params.map((value) => String(value)));
      }
      return services.admin.status();
    });
  }
  if (api.registerCli !== undefined) {
    api.registerCli(createAdminCliRegistrar(services.admin), {
      command: "agent-life",
      localOnly: true,
      remotePort: null,
    });
  }
};

export const registerAgentLifeGateway = (api: OpenClawPluginApi): void => {
  const services = composeGatewayServices({
    core: apiCore(api),
    storageRoot: apiStorageRoot(api),
    hostVersion: apiHostVersion(api),
    exposureMode: apiExposureMode(api),
  });
  const registration = Object.freeze({
    plugin: AGENT_LIFE_CHANNEL,
  });
  api.registerChannel(registration);
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
