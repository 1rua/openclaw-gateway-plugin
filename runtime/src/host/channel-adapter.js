import { registerDeviceTools } from "./device-tools.js";
import { existsSync } from "node:fs";
import { createGatewayCore } from "../core/gateway-core.js";
import { createGatewayRequestVerifier } from "../http/request-verifier.js";
import { dispatchGatewayMessageToOpenClaw, OPENCLAW_CHANNEL_ID } from "./inbound-dispatch.js";
import { createAdminCliRegistrar, bindAdminService, } from "../admin/cli.js";
import { createAdminPanel, createAdminService, } from "../admin/service.js";
import { createGatewayExposure, OPENCLAW_HOST_API, } from "../http/routes.js";
export const OPEN_ANDROID_INTELLIGENCE_CHANNEL = Object.freeze({
    id: "open-android-intelligence-gateway",
    meta: Object.freeze({
        id: "open-android-intelligence-gateway",
        label: "Open Android Intelligence Gateway",
        selectionLabel: "Open Android Intelligence Gateway",
        docsPath: "/gateway/open-android-intelligence",
        blurb: "Gateway Protocol v2 over the OpenClaw Gateway host",
    }),
    capabilities: {
        chatTypes: ["direct"],
        media: true,
    },
    config: {
        listAccountIds: (_config) => [],
        resolveAccount: (_config, accountId) => ({
            accountId: accountId ?? "default",
        }),
    },
    // Management is deliberately exposed through the host's local panel and
    // CLI, so no remote gateway method is advertised or registered here.
    gatewayMethods: [],
    gatewayMethodDescriptors: [],
});
const asLog = (value) => {
    const record = typeof value === "object" && value !== null ? value : undefined;
    if (record === undefined)
        return undefined;
    return Object.freeze({
        ...(typeof record["info"] === "function" ? { info: record["info"] } : {}),
        ...(typeof record["warn"] === "function" ? { warn: record["warn"] } : {}),
        ...(typeof record["error"] === "function" ? { error: record["error"] } : {}),
    });
};
const asInboundRuntime = (value) => {
    if (typeof value !== "object" || value === null)
        return undefined;
    const runtime = value;
    const inbound = runtime["inbound"];
    const routing = runtime["routing"];
    const session = runtime["session"];
    const reply = runtime["reply"];
    if (typeof inbound?.["run"] !== "function"
        || typeof inbound["buildContext"] !== "function"
        || typeof routing?.["resolveAgentRoute"] !== "function"
        || typeof session?.["resolveStorePath"] !== "function"
        || typeof session["recordInboundSession"] !== "function"
        || typeof reply?.["dispatchReplyWithBufferedBlockDispatcher"] !== "function")
        return undefined;
    return value;
};
const waitForWorkerTick = (signal) => new Promise((resolve) => {
    if (signal.aborted) {
        resolve();
        return;
    }
    const timer = setTimeout(done, 500);
    function done() {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        resolve();
    }
    signal.addEventListener("abort", done, { once: true });
});
const startInboundWorker = (core, channelAccountId, runtime, cfg, abortSignal, log) => {
    let nextAccountIndex = 0;
    const nextAttachmentSweepAt = new Map();
    if (runtime)
        core.setHostSessionResolver?.((accountId, conversationId) => {
            const route = runtime.routing.resolveAgentRoute({ cfg, channel: OPENCLAW_CHANNEL_ID, accountId: channelAccountId, peer: { kind: "direct", id: `${accountId}:${conversationId}` } });
            if (typeof route.agentId !== "string" || typeof route.sessionKey !== "string")
                return undefined;
            const session = cfg?.session;
            const storePath = runtime.session.resolveStorePath(session?.store, { agentId: route.agentId });
            return existsSync(storePath) ? { storePath, sessionKey: route.sessionKey } : undefined;
        });
    const run = async () => {
        while (!abortSignal.aborted) {
            const accountIds = core.listGatewayAccountIds?.() ?? [];
            let processed = false;
            for (let offset = 0; offset < accountIds.length && !abortSignal.aborted; offset += 1) {
                const index = (nextAccountIndex + offset) % accountIds.length;
                const accountId = accountIds[index];
                if (!core.accountExists(accountId))
                    continue;
                let account;
                try {
                    account = await core.openGatewayAccount(accountId);
                    if (Date.now() >= (nextAttachmentSweepAt.get(accountId) ?? 0)) {
                        const now = new Date();
                        account.attachments.expireDue();
                        account.attachments.cleanup();
                        account.events.purgeExpired(now);
                        account.deviceRequests.recoverExpired(now);
                        account.deviceRequests.purgeTerminalPayloads(now);
                        const marker = account.store.database.prepare("SELECT value FROM account_metadata WHERE key='native-history-maintenance-offset'").get();
                        const offset = Number(marker?.value ?? 0);
                        const conversations = account.conversations.list().slice(offset, offset + 10);
                        for (const conversation of conversations) {
                            try {
                                await account.conversations.listMessages(conversation.conversationId, { limit: 1 });
                            }
                            catch {
                                log?.warn?.(`Open Android native history maintenance deferred: accountId=${accountId}`);
                            }
                        }
                        account.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES ('native-history-maintenance-offset',?)").run(String(conversations.length === 10 ? offset + 10 : 0));
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
                    }
                    else {
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
                }
                catch (error) {
                    account?.close();
                    const candidate = error instanceof Error ? error.message : "";
                    const code = ["ATTACHMENT_STORAGE_UNAVAILABLE", "ATTACHMENT_READ_FAILED", "AGENT_UNAVAILABLE", "AGENT_MEDIA_REJECTED", "MODEL_REQUEST_REJECTED"]
                        .includes(candidate) ? candidate : "INTERNAL_ERROR";
                    log?.error?.(`Open Android Gateway inbound worker failed: accountId=${accountId} code=${code}`);
                }
            }
            if (!processed)
                await waitForWorkerTick(abortSignal);
        }
    };
    void run().catch((error) => {
        log?.error?.(`Open Android Gateway inbound worker stopped: code=${error instanceof Error ? error.name : "unknown"}`);
    });
};
export const createOpenAndroidIntelligenceChannel = (core) => {
    return Object.freeze({
        ...OPEN_ANDROID_INTELLIGENCE_CHANNEL,
        config: Object.freeze({
            // OpenClaw owns one channel account for this adapter process. Logical
            // Gateway users live in GatewayCore and are polled independently below.
            listAccountIds: (_config) => ["default"],
            resolveAccount: (_config, accountId) => ({
                accountId: accountId ?? "default",
            }),
        }),
        gateway: Object.freeze({
            startAccount: (rawContext) => {
                const context = typeof rawContext === "object" && rawContext !== null ? rawContext : {};
                const hostAccountId = typeof context["accountId"] === "string" ? context["accountId"] : "";
                const signal = context["abortSignal"] instanceof AbortSignal ? context["abortSignal"] : undefined;
                if (hostAccountId.length === 0 || signal === undefined) {
                    asLog(context["log"])?.error?.("Open Android channel startAccount missing accountId or AbortSignal");
                    return;
                }
                startInboundWorker(core, hostAccountId, asInboundRuntime(context["channelRuntime"]), context["cfg"], signal, asLog(context["log"]));
            },
        }),
    });
};
const exposureMode = (value) => {
    if (value === "loopback-reverse-proxy" || value === "direct-tls")
        return value;
    return "host-route";
};
export const composeGatewayServices = (options = {}) => {
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
const apiHostVersion = (api) => api.runtime?.version ?? api.hostVersion;
const apiStorageRoot = (api) => api.dataDir
    ?? api.runtime?.dataDir
    ?? (api.resolvePath === undefined ? undefined : api.resolvePath(".open-android-intelligence-openclaw/accounts"));
const apiCore = (api) => api.gatewayCore ?? api.runtime?.gatewayCore;
const apiVerifier = (api) => api.verifyRequest ?? api.runtime?.verifyRequest;
const apiExposureMode = (api) => exposureMode(api.pluginConfig?.exposureMode);
const registerManagementSurface = (api, services) => {
    bindAdminService(services.admin);
    if (api.registerAdminPanel !== undefined)
        api.registerAdminPanel(services.adminPanel);
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
export const registerOpenAndroidIntelligenceGateway = (api) => {
    const services = composeGatewayServices({
        core: apiCore(api),
        storageRoot: apiStorageRoot(api),
        hostVersion: apiHostVersion(api),
        exposureMode: apiExposureMode(api),
        verifyRequest: apiVerifier(api),
        maxBodyBytes: api.maxBodyBytes,
        tlsSpkiSha256: typeof api.pluginConfig?.["tlsSpkiSha256"] === "string" ? api.pluginConfig["tlsSpkiSha256"] : undefined,
    });
    const nativeGateway = api.runtime?.gateway;
    if (typeof nativeGateway?.request === "function")
        services.core.setGenerationCanceller?.(async (accountId, conversationId, generationId) => {
            const account = await services.core.openGatewayAccount(accountId);
            try {
                const generation = account.conversations.workflow.get(`generation:${generationId}`);
                if (generation?.state === "completed" || generation?.state === "failed")
                    return "ALREADY_COMPLETED";
                const binding = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`host-session:${conversationId}`);
                if (!binding)
                    return "OUTCOME_UNKNOWN";
                const trusted = JSON.parse(binding.value);
                // Pinned OpenClaw Runtime.gateway.request dispatches the real native stop RPC.
                const result = await nativeGateway.request("chat.abort", { sessionKey: trusted.sessionKey }, { timeoutMs: 8000 });
                if (result.ok === true && result.aborted === true)
                    return "CANCELLED";
                const terminal = account.conversations.workflow.get(`generation:${generationId}`);
                return terminal?.state === "completed" || terminal?.state === "failed" ? "ALREADY_COMPLETED" : "OUTCOME_UNKNOWN";
            }
            finally {
                account.close();
            }
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
    registerDeviceTools(api, services.core);
    registerManagementSurface(api, services);
};
