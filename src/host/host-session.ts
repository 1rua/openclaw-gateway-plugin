import { createHash } from "node:crypto";
import type { OpenClawInboundRuntime } from "./inbound-dispatch.js";
import { OPENCLAW_CHANNEL_ID } from "./inbound-dispatch.js";

/** Agent bindings select the agent; Gateway conversations always own distinct sessions. */
export const resolveGatewayHostSession = async (runtime: OpenClawInboundRuntime, cfg: unknown, channelAccountId: string,
  accountId: string, conversationId: string) => {
  const { buildAgentSessionKey } = await import("openclaw/plugin-sdk/routing");
  const peer = { kind: "direct" as const, id: createHash("sha256").update(JSON.stringify([accountId, conversationId])).digest("hex") };
  const route = runtime.routing.resolveAgentRoute({ cfg, channel: OPENCLAW_CHANNEL_ID, accountId: channelAccountId,
    peer: { kind: "direct", id: `${accountId}:${conversationId}` } }) as { agentId: string; accountId: string };
  const sessionKey = buildAgentSessionKey({ agentId: route.agentId, channel: OPENCLAW_CHANNEL_ID,
    accountId: route.accountId, peer, dmScope: "per-account-channel-peer" });
  const store = (cfg as { session?: { store?: string } } | undefined)?.session?.store;
  return { ...route, sessionKey, storePath: runtime.session.resolveStorePath(store, { agentId: route.agentId }) };
};
