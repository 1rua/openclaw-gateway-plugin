import { registerDeviceTools, type DeviceToolApi } from "./device-tools.js";
import {existsSync} from "node:fs";
import { createGatewayCore, type GatewayCore } from "../core/gateway-core.js";
import { createGatewayRequestVerifier } from "../http/request-verifier.js";
import { dispatchGatewayMessageToOpenClaw, OPENCLAW_CHANNEL_ID, type OpenClawInboundRuntime, type OpenClawLog } from "./inbound-dispatch.js";
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
  gateway?: Readonly<{
    startAccount: (context: unknown) => Promise<void> | void;
  }>;
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

const asLog = (value: unknown): OpenClawLog | undefined => {
  const record = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
  if (record === undefined) return undefined;
  return Object.freeze({
    ...(typeof record["info"] === "function" ? { info: record["info"] as (message: string) => void } : {}),
    ...(typeof record["warn"] === "function" ? { warn: record["warn"] as (message: string) => void } : {}),
    ...(typeof record["error"] === "function" ? { error: record["error"] as (message: string) => void } : {}),
  });
};

const asInboundRuntime = (value: unknown): OpenClawInboundRuntime | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const runtime = value as Record<string, unknown>;
  const inbound = runtime["inbound"] as Record<string, unknown> | undefined;
  const routing = runtime["routing"] as Record<string, unknown> | undefined;
  const session = runtime["session"] as Record<string, unknown> | undefined;
  const reply = runtime["reply"] as Record<string, unknown> | undefined;
  if (
    typeof inbound?.["run"] !== "function"
    || typeof inbound["buildContext"] !== "function"
    || typeof routing?.["resolveAgentRoute"] !== "function"
    || typeof session?.["resolveStorePath"] !== "function"
    || typeof session["recordInboundSession"] !== "function"
    || typeof reply?.["dispatchReplyWithBufferedBlockDispatcher"] !== "function"
  ) return undefined;
  return value as OpenClawInboundRuntime;
};

const waitForWorkerTick = (signal: AbortSignal): Promise<void> => new Promise((resolve) => {
  if (signal.aborted) { resolve(); return; }
  const timer = setTimeout(done, 500);
  function done(): void {
    clearTimeout(timer);
    signal.removeEventListener("abort", done);
    resolve();
  }
  signal.addEventListener("abort", done, { once: true });
});

const startInboundWorker = (
  core: GatewayCore,
  channelAccountId: string,
  runtime: OpenClawInboundRuntime | undefined,
  cfg: unknown,
  abortSignal: AbortSignal,
  log?: OpenClawLog,
): void => {
  let nextAccountIndex = 0;
  const nextAttachmentSweepAt = new Map<string, number>();
  if(runtime) core.setHostSessionResolver?.((accountId,conversationId)=> {
    const route=runtime.routing.resolveAgentRoute({cfg,channel:OPENCLAW_CHANNEL_ID,accountId:channelAccountId,peer:{kind:"direct",id:`${accountId}:${conversationId}`}}) as {agentId?:string;sessionKey?:string};
    if(typeof route.agentId!=="string" || typeof route.sessionKey!=="string") return undefined;
    const session=(cfg as {session?:{store?:string}}|undefined)?.session;
    const storePath=runtime.session.resolveStorePath(session?.store,{agentId:route.agentId});
    return existsSync(storePath) ? {storePath,sessionKey:route.sessionKey} : undefined;
  });
  const run = async (): Promise<void> => {
    while (!abortSignal.aborted) {
      const accountIds = core.listGatewayAccountIds?.() ?? [];
      let processed = false;
      for (let offset = 0; offset < accountIds.length && !abortSignal.aborted; offset += 1) {
        const index = (nextAccountIndex + offset) % accountIds.length;
        const accountId = accountIds[index]!;
        if (!core.accountExists(accountId)) continue;
        let account: Awaited<ReturnType<GatewayCore["openGatewayAccount"]>> | undefined;
        try {
          account = await core.openGatewayAccount(accountId);
          if (Date.now() >= (nextAttachmentSweepAt.get(accountId) ?? 0)) {
            const now = new Date();
            account.attachments.expireDue();
            account.attachments.cleanup();
            account.events.purgeExpired(now);
            account.deviceRequests.recoverExpired(now);
            account.deviceRequests.purgeTerminalPayloads(now);
            const marker=account.store.database.prepare("SELECT value FROM account_metadata WHERE key='native-history-maintenance-offset'").get() as {value:string}|undefined;
            const offset=Number(marker?.value ?? 0);
            const conversations=account.conversations.list().slice(offset,offset+10);
            for(const conversation of conversations) {
              try {await account.conversations.listMessages(conversation.conversationId,{limit:1});}
              catch {log?.warn?.(`Open Android native history maintenance deferred: accountId=${accountId}`);}
            }
            account.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES ('native-history-maintenance-offset',?)").run(String(conversations.length===10 ? offset+10 : 0));
            account.audit.purge(now);
            account.store.database.prepare(`DELETE FROM idempotency_ledger WHERE rowid IN
              (SELECT rowid FROM idempotency_ledger WHERE expires_at <= ? LIMIT 1000)`).run(now.toISOString());
            account.store.database.exec("PRAGMA wal_checkpoint(PASSIVE)");
            nextAttachmentSweepAt.set(accountId, Date.now() + 60_000);
          }
          const message = account.conversations.claimNextMessage();
          if (message === undefined) {
            account.close();
            continue;
          }
          processed = true;
          nextAccountIndex = (index + 1) % accountIds.length;
          if (runtime === undefined) {
            account.conversations.markFailed(message.messageId, "AGENT_UNAVAILABLE", `openclaw.host-api-missing.${message.messageId}`);
            log?.warn?.(`Open Android channel inbound API unavailable: messageId=${message.messageId}`);
          } else {
            await dispatchGatewayMessageToOpenClaw({
              account,
              message,
              channelRuntime: runtime,
              cfg,
              gatewayAccountId: accountId,
              channelAccountId,
              log,
            });
          }
          account.close();
          break;
        } catch (error) {
          account?.close();
          const candidate = error instanceof Error ? error.message : "";
          const code = ["ATTACHMENT_STORAGE_UNAVAILABLE", "ATTACHMENT_READ_FAILED", "AGENT_UNAVAILABLE", "AGENT_MEDIA_REJECTED", "MODEL_REQUEST_REJECTED"]
            .includes(candidate) ? candidate : "INTERNAL_ERROR";
          log?.error?.(`Open Android Gateway inbound worker failed: accountId=${accountId} code=${code}`);
        }
      }
      if (!processed) await waitForWorkerTick(abortSignal);
    }
  };
  void run().catch((error: unknown) => {
    log?.error?.(`Open Android Gateway inbound worker stopped: code=${error instanceof Error ? error.name : "unknown"}`);
  });
};

export const createOpenAndroidIntelligenceChannel = (core: GatewayCore): OpenClawChannelPlugin => {
  return Object.freeze({
    ...OPEN_ANDROID_INTELLIGENCE_CHANNEL,
    config: Object.freeze({
      // OpenClaw owns one channel account for this adapter process. Logical
      // Gateway users live in GatewayCore and are polled independently below.
      listAccountIds: (_config: unknown): string[] => ["default"],
      resolveAccount: (_config: unknown, accountId?: string | null): Readonly<{ accountId: string }> => ({
        accountId: accountId ?? "default",
      }),
    }),
    gateway: Object.freeze({
      startAccount: (rawContext: unknown): void => {
        const context = typeof rawContext === "object" && rawContext !== null ? rawContext as Record<string, unknown> : {};
        const hostAccountId = typeof context["accountId"] === "string" ? context["accountId"] : "";
        const signal = context["abortSignal"] instanceof AbortSignal ? context["abortSignal"] : undefined;
        if (hostAccountId.length === 0 || signal === undefined) {
          asLog(context["log"])?.error?.("Open Android channel startAccount missing accountId or AbortSignal");
          return;
        }
        startInboundWorker(
          core,
          hostAccountId,
          asInboundRuntime(context["channelRuntime"]),
          context["cfg"],
          signal,
          asLog(context["log"]),
        );
      },
    }),
  });
};

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

export type OpenClawPluginApi = DeviceToolApi & Readonly<{
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
    version?: string;
    dataDir?: string;
    gatewayCore?: GatewayCore;
    verifyRequest?: GatewayRequestVerifier;
    gateway?: Readonly<{ request: (method:string,params?:Record<string,unknown>,options?:unknown)=>Promise<unknown> }>;
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
  tlsSpkiSha256?: string;
}>;

const exposureMode = (value: unknown): ExposureMode => {
  if (value === "loopback-reverse-proxy" || value === "direct-tls") return value;
  return "host-route";
};

export const composeGatewayServices = (options: ComposeGatewayServicesOptions = {}): GatewayServices => {
  const hostApi = options.hostApi ?? OPENCLAW_HOST_API;
  const core = options.core ?? createGatewayCore({ storageRoot: options.storageRoot, tlsSpkiSha256: options.tlsSpkiSha256 });
  const admin = createAdminService({ core, hostVersion: options.hostVersion, hostApi });
  const exposure = createGatewayExposure(options.exposureMode ?? "host-route", {
    core,
    hostVersion: options.hostVersion,
    hostApi,
    verifyRequest: options.verifyRequest ?? createGatewayRequestVerifier(core),
    maxBodyBytes: options.maxBodyBytes,
  });
  return Object.freeze({ core, admin, adminPanel: createAdminPanel(admin), exposure });
};

// OpenClaw's `api.version` is plugin metadata, not the host API version.
// Only an explicit trusted host-version adapter may enable this integration.
const apiHostVersion = (api: OpenClawPluginApi): string | undefined => api.runtime?.version ?? api.hostVersion;

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
    tlsSpkiSha256: typeof api.pluginConfig?.["tlsSpkiSha256"] === "string" ? api.pluginConfig["tlsSpkiSha256"] : undefined,
  });
  const nativeGateway=api.runtime?.gateway;
  if (typeof nativeGateway?.request === "function") services.core.setGenerationCanceller?.(async(accountId,conversationId,generationId)=> {
    const account=await services.core.openGatewayAccount(accountId);
    try {
      const generation=account.conversations.workflow.get<{state:string}>(`generation:${generationId}`);
      if (generation?.state === "completed" || generation?.state === "failed") return "ALREADY_COMPLETED";
      const binding=account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`host-session:${conversationId}`) as {value:string}|undefined;
      if (!binding) return "OUTCOME_UNKNOWN";
      const trusted=JSON.parse(binding.value) as {sessionKey:string};
      // Pinned OpenClaw Runtime.gateway.request dispatches the real native stop RPC.
      const result=await nativeGateway.request("chat.abort",{sessionKey:trusted.sessionKey},{timeoutMs:8000}) as {ok?:boolean;aborted?:boolean};
      if (result.ok === true && result.aborted === true) return "CANCELLED";
      const terminal=account.conversations.workflow.get<{state:string}>(`generation:${generationId}`);
      return terminal?.state === "completed" || terminal?.state === "failed" ? "ALREADY_COMPLETED" : "OUTCOME_UNKNOWN";
    } finally { account.close(); }
  });
  api.registerChannel(Object.freeze({
    plugin: createOpenAndroidIntelligenceChannel(services.core),
  }));
  for (const route of services.exposure.routes) {
    api.registerHttpRoute({
      path: route.path,
      auth: route.auth,
      match: route.match,
      handler: route.handler,
    });
  }
  registerDeviceTools(api,services.core);
  registerManagementSurface(api, services);
};
