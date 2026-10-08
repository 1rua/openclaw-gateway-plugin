import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const object = (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("SCHEMA_INVALID");
    return value;
};
export const validateBatch = (input, conversationId) => {
    const body = object(input);
    if (Object.keys(body).some(key => !["clientBatchId", "clientConversationId", "joinMode", "members"].includes(key))
        || typeof body.clientBatchId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(body.clientBatchId)
        || body.joinMode !== "newline-v1" || (body.clientConversationId !== undefined && body.clientConversationId !== conversationId)
        || !Array.isArray(body.members) || body.members.length < 1 || body.members.length > 20)
        throw new Error("SCHEMA_INVALID");
    const seen = new Set();
    const members = body.members.map(raw => {
        const m = object(raw);
        if (Object.keys(m).sort().join() !== "clientMessageId,text" || typeof m.clientMessageId !== "string"
            || !/^[A-Za-z0-9._~-]{1,128}$/.test(m.clientMessageId) || seen.has(m.clientMessageId)
            || typeof m.text !== "string" || !m.text || m.text.trimStart().startsWith("/"))
            throw new Error("SCHEMA_INVALID");
        seen.add(m.clientMessageId);
        return { clientMessageId: m.clientMessageId, text: m.text };
    });
    if (Buffer.byteLength(members.map(m => m.text).join("\n")) > 64 * 1024)
        throw new Error("SCHEMA_INVALID");
    return { clientBatchId: body.clientBatchId, members };
};
/** Native transcripts own text. These records contain identities and offsets only. */
export class ConversationWorkflow {
    store;
    events;
    constructor(store, events) {
        this.store = store;
        this.events = events;
    }
    get(key) {
        const row = this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key);
        return row ? JSON.parse(row.value) : undefined;
    }
    put(key, value) {
        this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key, JSON.stringify(value));
    }
    register(accepted, deviceId, createdAt) {
        const generationId = `gen_${digest(accepted.messageId).slice(0, 40)}`;
        const order = (this.get("generation-order") ?? 0) + 1;
        this.put("generation-order", order);
        this.put(`generation:${generationId}`, { order, generationId, conversationId: accepted.conversationId,
            messageIds: [accepted.messageId], deviceId, createdAt, state: "queued" });
        this.put(`message-generation:${accepted.messageId}`, generationId);
        return generationId;
    }
    forMessage(messageId) {
        const gid = this.get(`message-generation:${messageId}`);
        return gid ? this.get(`generation:${gid}`) : undefined;
    }
    current(conversationId) {
        const rows = this.store.database.prepare("SELECT value FROM account_metadata WHERE key LIKE 'generation:%'").all();
        const active = rows.map(r => JSON.parse(r.value)).filter(r => r.conversationId === conversationId && ["queued", "running", "unknown"].includes(r.state))
            .sort((a, b) => Number(a.state === "queued") - Number(b.state === "queued") || (a.order ?? 0) - (b.order ?? 0));
        const first = active[0];
        return first ? { generationId: first.generationId, conversationId: first.conversationId, state: first.state } : null;
    }
    acceptBatch(conversationId, input, context, accept) {
        const body = validateBatch(input, conversationId);
        const key = `batch:${conversationId}:${body.clientBatchId}`;
        const inputHash = digest(canonicalize(input) ?? "null");
        const previous = this.get(key);
        if (previous) {
            if (previous.digest !== inputHash || previous.deviceId !== context.deviceId)
                throw new Error("IDEMPOTENCY_CONFLICT");
            return previous.acceptance;
        }
        for (const member of body.members)
            if (this.store.database.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND client_message_id=?").get(conversationId, member.clientMessageId))
                throw new Error("IDEMPOTENCY_CONFLICT");
        const accepted = body.members.map(accept);
        const leader = accepted[0].messageId;
        const generation = this.forMessage(leader);
        const offsets = [];
        let start = 0;
        body.members.forEach((member, index) => {
            const ack = accepted[index];
            offsets.push({ messageId: ack.messageId, clientMessageId: member.clientMessageId, start, length: member.text.length });
            start += member.text.length + 1;
            if (ack.messageId !== leader) {
                this.store.database.prepare("UPDATE messages SET dispatchable=0 WHERE message_id=?").run(ack.messageId);
                this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(`generation:${this.forMessage(ack.messageId).generationId}`);
            }
            this.put(`message-generation:${ack.messageId}`, generation.generationId);
        });
        generation.messageIds = accepted.map(a => a.messageId);
        generation.batchId = `batch_${digest(key).slice(0, 40)}`;
        generation.offsets = offsets;
        generation.aggregateSha256 = digest(body.members.map(m => m.text).join("\n"));
        this.put(`generation:${generation.generationId}`, generation);
        for (let index = 0; index < accepted.length; index++)
            this.events.append({ eventType: "conversation.message.status", correlationId: context.correlationId,
                payload: { conversationId, messageId: accepted[index].messageId, clientMessageId: body.members[index].clientMessageId,
                    generationId: generation.generationId, status: "queued", revision: 0, errorCode: null }, now: new Date(generation.createdAt) });
        const acceptance = { batchId: generation.batchId, generationId: generation.generationId, status: "accepted",
            members: body.members.map((m, index) => ({ clientMessageId: m.clientMessageId, messageId: accepted[index].messageId })) };
        this.put(key, { digest: inputHash, deviceId: context.deviceId, acceptance });
        return acceptance;
    }
    aggregate(messageId, original) {
        const generation = this.forMessage(messageId);
        if (!generation?.offsets)
            return original;
        return generation.messageIds.map(mid => {
            const row = this.store.database.prepare("SELECT body FROM messages WHERE message_id=?").get(mid);
            if (!row?.body)
                throw new Error("OUTCOME_UNKNOWN");
            return this.store.openString(row.body, `message:${mid}`);
        }).join("\n");
    }
    claim(messageId) {
        const generation = this.forMessage(messageId);
        if (!generation)
            return true;
        if (generation.state !== "queued")
            return false;
        const others = this.store.database.prepare("SELECT value FROM account_metadata WHERE key LIKE 'generation:%'").all();
        for (const row of others) {
            const other = JSON.parse(row.value);
            if (other.generationId === generation.generationId || other.conversationId !== generation.conversationId)
                continue;
            if (["running", "unknown"].includes(other.state) || (other.state === "queued" && (other.order ?? 0) < (generation.order ?? 0)))
                return false;
        }
        generation.state = "running";
        this.put(`generation:${generation.generationId}`, generation);
        return true;
    }
    settle(messageId, state) {
        const generation = this.forMessage(messageId);
        if (generation && ["queued", "running", "unknown"].includes(generation.state)) {
            generation.state = state;
            this.put(`generation:${generation.generationId}`, generation);
        }
    }
    async prepareCancel(conversationId, generationId, context, cancel) {
        const generation = this.get(`generation:${generationId}`);
        if (!generation || generation.conversationId !== conversationId)
            throw new Error("SCHEMA_INVALID");
        const origin = this.get(`message-device:${generation.messageIds[0]}`);
        if (!origin || origin.deviceId !== context.deviceId || origin.pairingGeneration !== context.pairingGeneration)
            throw new Error("PAIRING_GENERATION_STALE");
        if (generation.state === "cancelled")
            return "CANCELLED";
        if (["completed", "failed"].includes(generation.state))
            return "ALREADY_COMPLETED";
        if (generation.state === "queued") {
            this.settle(generation.messageIds[0], "cancelled");
            this.store.database.prepare("UPDATE messages SET dispatchable=0 WHERE message_id=?").run(generation.messageIds[0]);
            return "CANCELLED";
        }
        if (!cancel)
            return "UNSUPPORTED";
        this.settle(generation.messageIds[0], "unknown");
        try {
            return await cancel();
        }
        catch {
            return "OUTCOME_UNKNOWN";
        }
    }
    finishCancel(conversationId, generationId, outcome, context, now = new Date()) {
        if (!["CANCELLED", "ALREADY_COMPLETED", "UNSUPPORTED", "OUTCOME_UNKNOWN"].includes(outcome))
            throw new Error("SCHEMA_INVALID");
        const generation = this.get(`generation:${generationId}`);
        if (outcome === "CANCELLED") {
            generation.state = "cancelled";
            this.put(`generation:${generationId}`, generation);
            for (const mid of generation.messageIds)
                this.store.database.prepare("UPDATE messages SET body='',dispatchable=0,next_attempt_at=NULL WHERE message_id=?").run(mid);
            this.events.append({ eventType: "conversation.generation.cancelled", correlationId: context.correlationId,
                payload: { conversationId, generationId, outcome }, now });
        }
        else if (outcome === "ALREADY_COMPLETED")
            this.settle(generation.messageIds[0], "completed");
        return { outcome, generationId };
    }
    expandHistory(row) {
        const generation = this.forMessage(row.messageId);
        if (!generation?.offsets || row.sender !== "user" || (row.state !== "DELETED" && digest(row.text) !== generation.aggregateSha256))
            return [row];
        return generation.offsets.map(part => {
            const text = row.state === "DELETED" ? "" : row.text.slice(part.start, part.start + part.length);
            return { ...row, messageId: part.messageId, clientMessageId: part.clientMessageId, batchId: generation.batchId,
                text, parts: row.state === "DELETED" ? [] : [{ type: "text", text }] };
        });
    }
}
