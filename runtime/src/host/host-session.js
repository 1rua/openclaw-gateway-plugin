import { createHash } from "node:crypto";
import { OPENCLAW_CHANNEL_ID } from "./inbound-dispatch.js";
/** Agent bindings select the agent; Gateway conversations always own distinct sessions. */
export const resolveGatewayHostSession = async (runtime, cfg, channelAccountId, accountId, conversationId) => {
    const { buildAgentSessionKey } = await import("openclaw/plugin-sdk/routing");
    const peer = { kind: "direct", id: createHash("sha256").update(JSON.stringify([accountId, conversationId])).digest("hex") };
    const route = runtime.routing.resolveAgentRoute({ cfg, channel: OPENCLAW_CHANNEL_ID, accountId: channelAccountId,
        peer: { kind: "direct", id: `${accountId}:${conversationId}` } });
    const sessionKey = buildAgentSessionKey({ agentId: route.agentId, channel: OPENCLAW_CHANNEL_ID,
        accountId: route.accountId, peer, dmScope: "per-account-channel-peer" });
    const store = cfg?.session?.store;
    return { ...route, sessionKey, storePath: runtime.session.resolveStorePath(store, { agentId: route.agentId }) };
};
