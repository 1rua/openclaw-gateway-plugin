import { createHash } from "node:crypto";
import type { OpenClawInboundRuntime } from "./inbound-dispatch.js";
import { OPENCLAW_CHANNEL_ID } from "./inbound-dispatch.js";

export type HostSessionBinding = Readonly<{storePath:string;sessionKey:string;agentId?:string;accountId?:string}>;

/** Agent bindings select the agent; Gateway conversations always own distinct sessions. */
export const resolveGatewayHostSession = async (runtime: OpenClawInboundRuntime, cfg: unknown, channelAccountId: string,
  accountId: string, conversationId: string, existing?: HostSessionBinding) => {
  const { buildAgentSessionKey, parseAgentSessionKey, normalizeAccountId } = await import("openclaw/plugin-sdk/routing");
  if (existing) {
    const parsed=parseAgentSessionKey(existing.sessionKey);
    const agentId=existing.agentId ?? parsed?.agentId;
    if (!agentId || parsed && parsed.agentId !== agentId) throw new Error("AGENT_UNAVAILABLE");
    const scope=parsed?.rest.split(":") ?? [];
    const scopedAccount=scope[0]===OPENCLAW_CHANNEL_ID && scope[2]==="direct" ? scope[1] : undefined;
    const ownerAccountId=existing.accountId ?? scopedAccount ?? channelAccountId;
    return {storePath:existing.storePath,sessionKey:existing.sessionKey,agentId,accountId:normalizeAccountId(ownerAccountId)};
  }
  const peer = { kind: "direct" as const, id: createHash("sha256").update(JSON.stringify([accountId, conversationId])).digest("hex") };
  const route = runtime.routing.resolveAgentRoute({ cfg, channel: OPENCLAW_CHANNEL_ID, accountId: channelAccountId,
    peer: { kind: "direct", id: `${accountId}:${conversationId}` } }) as { agentId: string; accountId: string };
  const sessionKey = buildAgentSessionKey({ agentId: route.agentId, channel: OPENCLAW_CHANNEL_ID,
    accountId: route.accountId, peer, dmScope: "per-account-channel-peer" });
  const store = (cfg as { session?: { store?: string } } | undefined)?.session?.store;
  return { agentId:route.agentId,accountId:route.accountId, sessionKey, storePath: runtime.session.resolveStorePath(store, { agentId: route.agentId }) };
};
