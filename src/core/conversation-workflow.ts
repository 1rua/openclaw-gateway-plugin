import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import type { GatewayAccountStore } from "./account-store.js";
import type { EventStore } from "./event-store.js";
import type { VerifiedRequestContext } from "./gateway-core.js";

type Member = { clientMessageId: string; text: string };
type Acceptance = { messageId: string; conversationId: string; generationId?: string };
type Generation = {
  generationId: string; conversationId: string; messageIds: string[]; deviceId: string;
  state: "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";
  createdAt: string; order?:number; batchId?: string; aggregateSha256?: string;
  offsets?: Array<{ messageId: string; clientMessageId: string; start: number; length: number }>;
};
export type GenerationCanceller = (accountId: string, conversationId: string, generationId: string) => Promise<"CANCELLED" | "ALREADY_COMPLETED" | "UNSUPPORTED" | "OUTCOME_UNKNOWN">;
const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SCHEMA_INVALID");
  return value as Record<string, unknown>;
};
export const validateBatch = (input: unknown, conversationId: string): Readonly<{ clientBatchId: string; members: Member[] }> => {
  const body = object(input);
  if (Object.keys(body).some(key => !["clientBatchId", "clientConversationId", "joinMode", "members"].includes(key))
    || typeof body.clientBatchId !== "string" || !/^[A-Za-z0-9._~-]{1,128}$/.test(body.clientBatchId)
    || body.joinMode !== "newline-v1" || (body.clientConversationId !== undefined && body.clientConversationId !== conversationId)
    || !Array.isArray(body.members) || body.members.length < 1 || body.members.length > 20) throw new Error("SCHEMA_INVALID");
  const seen = new Set<string>();
  const members = body.members.map(raw => {
    const m = object(raw);
    if (Object.keys(m).sort().join() !== "clientMessageId,text" || typeof m.clientMessageId !== "string"
      || !/^[A-Za-z0-9._~-]{1,128}$/.test(m.clientMessageId) || seen.has(m.clientMessageId)
      || typeof m.text !== "string" || !m.text || m.text.trimStart().startsWith("/")) throw new Error("SCHEMA_INVALID");
    seen.add(m.clientMessageId);
    return { clientMessageId: m.clientMessageId, text: m.text };
  });
  if (Buffer.byteLength(members.map(m => m.text).join("\n")) > 64 * 1024) throw new Error("SCHEMA_INVALID");
  return { clientBatchId: body.clientBatchId, members };
};

/** Native transcripts own text. These records contain identities and offsets only. */
export class ConversationWorkflow {
  constructor(private store: GatewayAccountStore, private events: EventStore) {}
  get<T>(key: string): T | undefined {
    const row = this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) as T : undefined;
  }
  put(key: string, value: unknown): void {
    this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key, JSON.stringify(value));
  }
  register(accepted: Acceptance, deviceId: string, createdAt: string): string {
    const generationId = `gen_${digest(accepted.messageId).slice(0,40)}`;
    const order=(this.get<number>("generation-order") ?? 0)+1;
    this.put("generation-order",order);
    this.put(`generation:${generationId}`, { order, generationId, conversationId: accepted.conversationId,
      messageIds: [accepted.messageId], deviceId, createdAt, state: "queued" });
    this.put(`message-generation:${accepted.messageId}`, generationId);
    return generationId;
  }
  forMessage(messageId: string): Generation | undefined {
    const gid = this.get<string>(`message-generation:${messageId}`);
    return gid ? this.get<Generation>(`generation:${gid}`) : undefined;
  }
  current(conversationId:string):Pick<Generation,"generationId"|"conversationId"|"state">|null {
    const rows=this.store.database.prepare("SELECT value FROM account_metadata WHERE key LIKE 'generation:%'").all() as Array<{value:string}>;
    const active=rows.map(r=>JSON.parse(r.value) as Generation).filter(r=>r.conversationId===conversationId && ["queued","running","unknown"].includes(r.state))
      .sort((a,b)=>Number(a.state==="queued")-Number(b.state==="queued") || (a.order ?? 0)-(b.order ?? 0));
    const first=active[0];return first ? {generationId:first.generationId,conversationId:first.conversationId,state:first.state} : null;
  }
  acceptBatch(conversationId: string, input: unknown, context: VerifiedRequestContext,
    accept: (member: Member) => Acceptance): Record<string, unknown> {
    const body = validateBatch(input,conversationId);
    const key = `batch:${conversationId}:${body.clientBatchId}`;
    const inputHash = digest(canonicalize(input) ?? "null");
    const previous = this.get<{ digest: string; deviceId: string; acceptance: Record<string, unknown> }>(key);
    if (previous) {
      if (previous.digest !== inputHash || previous.deviceId !== context.deviceId) throw new Error("IDEMPOTENCY_CONFLICT");
      return previous.acceptance;
    }
    for (const member of body.members) if (this.store.database.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND client_message_id=?").get(conversationId,member.clientMessageId)) throw new Error("IDEMPOTENCY_CONFLICT");
    const accepted = body.members.map(accept);
    const leader = accepted[0]!.messageId;
    const generation = this.forMessage(leader)!;
    const offsets: NonNullable<Generation["offsets"]> = [];
    let start = 0;
    body.members.forEach((member,index) => {
      const ack = accepted[index]!;
      offsets.push({ messageId: ack.messageId, clientMessageId: member.clientMessageId, start, length: member.text.length });
      start += member.text.length + 1;
      if (ack.messageId !== leader) {
        this.store.database.prepare("UPDATE messages SET dispatchable=0 WHERE message_id=?").run(ack.messageId);
        this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(`generation:${this.forMessage(ack.messageId)!.generationId}`);
      }
      this.put(`message-generation:${ack.messageId}`,generation.generationId);
    });
    generation.messageIds = accepted.map(a => a.messageId);
    generation.batchId = `batch_${digest(key).slice(0,40)}`;
    generation.offsets = offsets;
    generation.aggregateSha256 = digest(body.members.map(m => m.text).join("\n"));
    this.put(`generation:${generation.generationId}`,generation);
    for (let index=0;index<accepted.length;index++) this.events.append({eventType:"conversation.message.status",correlationId:context.correlationId,
      payload:{conversationId,messageId:accepted[index]!.messageId,clientMessageId:body.members[index]!.clientMessageId,
        generationId:generation.generationId,status:"queued",revision:0,errorCode:null},now:new Date(generation.createdAt)});
    const acceptance = { batchId: generation.batchId, generationId: generation.generationId, status: "accepted",
      members: body.members.map((m,index) => ({ clientMessageId: m.clientMessageId, messageId: accepted[index]!.messageId })) };
    this.put(key,{ digest: inputHash, deviceId: context.deviceId, acceptance });
    return acceptance;
  }
  aggregate(messageId: string, original: string): string {
    const generation = this.forMessage(messageId);
    if (!generation?.offsets) return original;
    return generation.messageIds.map(mid => {
      const row = this.store.database.prepare("SELECT body FROM messages WHERE message_id=?").get(mid) as { body: string } | undefined;
      if (!row?.body) throw new Error("OUTCOME_UNKNOWN");
      return this.store.openString(row.body,`message:${mid}`);
    }).join("\n");
  }
  claim(messageId: string): boolean {
    const generation = this.forMessage(messageId);
    if (!generation) return true;
    if (generation.state !== "queued") return false;
    const others = this.store.database.prepare("SELECT value FROM account_metadata WHERE key LIKE 'generation:%'").all() as Array<{ value: string }>;
    for (const row of others) {
      const other = JSON.parse(row.value) as Generation;
      if (other.generationId === generation.generationId || other.conversationId !== generation.conversationId) continue;
      if (["running", "unknown"].includes(other.state) || (other.state === "queued" && (other.order ?? 0) < (generation.order ?? 0))) return false;
    }
    generation.state = "running";
    this.put(`generation:${generation.generationId}`,generation);
    return true;
  }
  settle(messageId: string, state: Generation["state"]): void {
    const generation = this.forMessage(messageId);
    if (generation && ["queued", "running", "unknown"].includes(generation.state)) {
      generation.state = state;
      this.put(`generation:${generation.generationId}`,generation);
    }
  }
  async prepareCancel(conversationId: string, generationId: string, context: VerifiedRequestContext, cancel?: () => ReturnType<GenerationCanceller>): Promise<string> {
    const generation = this.get<Generation>(`generation:${generationId}`);
    if (!generation || generation.conversationId !== conversationId) throw new Error("SCHEMA_INVALID");
    const origin = this.get<{ deviceId: string; pairingGeneration: number }>(`message-device:${generation.messageIds[0]}`);
    if (!origin || origin.deviceId !== context.deviceId || origin.pairingGeneration !== context.pairingGeneration) throw new Error("PAIRING_GENERATION_STALE");
    if (generation.state === "cancelled") return "CANCELLED";
    if (["completed", "failed"].includes(generation.state)) return "ALREADY_COMPLETED";
    if (generation.state === "queued") {
      this.settle(generation.messageIds[0]!,"cancelled");
      this.store.database.prepare("UPDATE messages SET dispatchable=0 WHERE message_id=?").run(generation.messageIds[0]!);
      return "CANCELLED";
    }
    if (!cancel) return "UNSUPPORTED";
    this.settle(generation.messageIds[0]!,"unknown");
    try { return await cancel(); } catch { return "OUTCOME_UNKNOWN"; }
  }
  finishCancel(conversationId: string, generationId: string, outcome: string, context: VerifiedRequestContext, now = new Date()): Record<string, unknown> {
    if (!["CANCELLED", "ALREADY_COMPLETED", "UNSUPPORTED", "OUTCOME_UNKNOWN"].includes(outcome)) throw new Error("SCHEMA_INVALID");
    const generation = this.get<Generation>(`generation:${generationId}`)!;
    if (outcome === "CANCELLED") {
      generation.state = "cancelled";
      this.put(`generation:${generationId}`,generation);
      for (const mid of generation.messageIds) this.store.database.prepare("UPDATE messages SET body='',dispatchable=0,next_attempt_at=NULL WHERE message_id=?").run(mid);
      this.events.append({ eventType: "conversation.generation.cancelled", correlationId: context.correlationId,
        payload: { conversationId, generationId, outcome }, now });
    } else if (outcome === "ALREADY_COMPLETED") this.settle(generation.messageIds[0]!,"completed");
    return { outcome, generationId };
  }
  expandHistory<T extends { messageId: string; sender: string; text: string; parts: unknown[]; state: string }>(row: T): T[] {
    const generation = this.forMessage(row.messageId);
    if (!generation?.offsets || row.sender !== "user" || (row.state !== "DELETED" && digest(row.text) !== generation.aggregateSha256)) return [row];
    return generation.offsets.map(part => {
      const text = row.state === "DELETED" ? "" : row.text.slice(part.start,part.start+part.length);
      return { ...row, messageId: part.messageId, clientMessageId: part.clientMessageId, batchId: generation.batchId,
        text, parts: row.state === "DELETED" ? [] : [{ type: "text", text }] };
    });
  }
}
