import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, writeFileSync, writeSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createGatewayCore, type GatewayAccount, type VerifiedRequestContext } from "../src/core/gateway-core.js";
import { HistoryMedia } from "../src/core/history-media.js";
import { createGatewayRoutes } from "../src/http/routes.js";
import { createGatewayRequestVerifier } from "../src/http/request-verifier.js";
import { canonicalRequestSignatureInput } from "../gateway-contract/src/request-signature.js";
import { dispatchGatewayMessageToOpenClaw, type OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";

const context: VerifiedRequestContext = { accountId: "acct_media", deviceId: "dev_media", sessionId: "sess_media", requestId: "req_media", correlationId: "cor_media", pairingGeneration: 1, grantRevision: 1 };
const temporary = () => mkdtempSync(join(tmpdir(), "oai-history-recovery-"));
beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", temporary()));
afterEach(() => vi.unstubAllEnvs());

const privateRecord = (account: GatewayAccount, id: string): Record<string, unknown> => {
  const key = `history-media:${id}`;
  const row = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as { value: string };
  return account.store.openJson(row.value, key) as Record<string, unknown>;
};
const installSession = (account: GatewayAccount): void => {
  account.store.database.prepare("INSERT INTO device_keys(device_id,installation_id,public_key,registered_at) VALUES (?,?,?,?)").run(context.deviceId, "install_media", "A".repeat(43), new Date().toISOString());
  account.store.database.prepare("INSERT INTO access_sessions(session_id,installation_id,device_id,status,created_at,expires_at) VALUES (?,?,?,'active',?,?)").run(context.sessionId, "install_media", context.deviceId, new Date().toISOString(), "2999-01-01T00:00:00.000Z");
};

it("大原件在交付前持久采用，临时源退休后可流式读取并按原身份重试", async () => {
  const root = temporary();
  const path = join(root, "large.bin");
  const block = Buffer.alloc(64 * 1024, 0x75);
  const hash = createHash("sha256");
  const fd = openSync(path, "wx");
  for (let index = 0; index < 480; index += 1) { writeSync(fd, block); hash.update(block); }
  closeSync(fd);
  const account = await createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }).openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_large", correlationId: "cor_large" }).conversationId;
    const media = new HistoryMedia(account.store, account.accountId);
    const part = media.register(cid, "msg_large", path, "application/x-agent", [root]);
    const id = String(part.attachmentId);
    renameSync(path, path + ".retired");
    expect(media.register(cid, "msg_large", path, "application/x-agent", [root])).toEqual(part);
    expect(media.metadata(cid, id, "stream-v1")).toMatchObject({ remoteAvailable: true, sizeBytes: 480 * block.length });
    const token = String(media.grant(cid, id, context, undefined, "stream-v1").grantId);
    const stream = media.contentStream(cid, id, token, context);
    const received = createHash("sha256"); let length = 0;
    try { for await (const chunk of stream.chunks()) { expect(chunk.length).toBeLessThanOrEqual(64 * 1024); length += chunk.length; received.update(chunk); } }
    finally { stream.close(); }
    expect(length).toBe(480 * block.length);
    expect(received.digest("hex")).toBe(hash.digest("hex"));
    expect(() => media.contentStream(cid, id, token, context)).toThrow("AUTHENTICATION_FAILED");
  } finally { account.close(); }
});

it.each(["format=", "format=stream-v2", "format=stream-v1&format=stream-v1", "extra=value&format=stream-v1"])("历史端点拒绝非闭集查询参数：%s", async query => {
  const root = temporary(); const path = join(root, "file.bin"); writeFileSync(path, "original");
  const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) });
  const account = await core.openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_query", correlationId: "cor_query" }).conversationId;
    const part = new HistoryMedia(account.store, account.accountId).register(cid, "msg_query", path, "application/octet-stream", [root]);
    for (const endpoint of ["metadata", "cache-grant"]) {
      const result = await core.handle({ context, method: endpoint === "metadata" ? "GET" : "POST", target: `/open-android-intelligence/v2/conversations/${cid}/attachments/${part.attachmentId}/${endpoint}?${query}`, body: {} });
      expect(result.error?.code).toBe("SCHEMA_INVALID");
    }
  } finally { account.close(); }
});

it("旧 JSON 表示仍有界，单次 grant 同时绑定格式、期限、账号和设备", async () => {
  const root = temporary(); const path = join(root, "original.json"); writeFileSync(path, '{"content":"原件"}');
  const account = await createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }).openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_old", correlationId: "cor_old" }).conversationId;
    const media = new HistoryMedia(account.store, account.accountId);
    const id = String(media.register(cid, "msg_old", path, "application/json", [root]).attachmentId);
    const old = String(media.grant(cid, id, context).grantId);
    expect(() => media.contentStream(cid, id, old, context)).toThrow("AUTHENTICATION_FAILED");
    expect(Buffer.from(media.content(cid, id, old, context).body).toString()).toBe('{"content":"原件"}');
    expect(() => media.content(cid, id, old, context)).toThrow("AUTHENTICATION_FAILED");
    const grant = String(media.grant(cid, id, context, undefined, "stream-v1").grantId);
    for (const changed of [{ accountId: "acct_other" }, { deviceId: "dev_other" }, { pairingGeneration: 2 }, { grantRevision: 2 }]) {
      expect(() => media.contentStream(cid, id, grant, { ...context, ...changed })).toThrow("AUTHENTICATION_FAILED");
    }
    expect(() => media.contentStream(cid, id, grant, context, new Date(Date.now() + 121_000))).toThrow("AUTHENTICATION_FAILED");
    const stream = media.contentStream(cid, id, grant, { ...context, sessionId: "sess_refreshed" });
    stream.close();
    const metadata = media.metadata(cid, id, "stream-v1");
    expect(metadata).not.toHaveProperty("path"); expect(metadata).not.toHaveProperty("sourcePath"); expect(metadata).not.toHaveProperty("storageOwner");
  } finally { account.close(); }
});

it.each(["grantId=a&grantId=b&format=stream-v1", "format=stream-v1", "format=stream-v1&grantId="])("content 拒绝缺失或重复的一次性凭据：%s", async query => {
  const root = temporary(); const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }); const account = await core.openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_token", correlationId: "cor_token" }).conversationId;
    const result = await core.handle({ context, method: "GET", target: `/open-android-intelligence/v2/conversations/${cid}/attachments/media_unknown/content?${query}` });
    expect(result.error?.code).toBe("SCHEMA_INVALID");
  } finally { account.close(); }
});

it.each(["grant", "session", "source", "native"])("已打开的原件流在授权、原件或宿主删除变化后停止：%s", async action => {
  const root = temporary(); const path = join(root, "stream.bin"); writeFileSync(path, Buffer.alloc(3 * 64 * 1024, 0x73));
  const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }); const account = await core.openGatewayAccount(context.accountId);
  try {
    installSession(account);
    const cid = account.conversations.create({ clientConversationId: "cc_stop", correlationId: "cor_stop" }).conversationId;
    if (action === "native") {
      const store = join(root, "native-store.json");
      writeFileSync(store, JSON.stringify({ "agent:stop": { sessionId: "native-stop", sessionFile: "native-stop.jsonl" } }));
      writeFileSync(join(root, "native-stop.jsonl"), JSON.stringify({ type: "message", id: "stop", message: { role: "assistant", content: [] } }) + "\n");
      account.conversations.bindHostSession(cid, { storePath: store, sessionKey: "agent:stop" });
      account.conversations.recordHistoryBinding(cid, "msg_stop", "assistant", "");
    }
    const media = new HistoryMedia(account.store, account.accountId); const id = String(media.register(cid, "msg_stop", path, undefined, [root]).attachmentId);
    const token = String(media.grant(cid, id, context, undefined, "stream-v1").grantId);
    const response = await core.handle({ context, method: "GET", target: `/open-android-intelligence/v2/conversations/${cid}/attachments/${id}/content?format=stream-v1&grantId=${token}` });
    expect(response.error).toBeUndefined(); expect(JSON.stringify(response)).not.toContain("bodyStream");
    const blocks = response.bodyStream!.chunks(); expect((await blocks.next()).value?.length).toBe(64 * 1024);
    if (action === "grant") account.store.database.prepare("UPDATE device_keys SET grant_revision=2 WHERE device_id=?").run(context.deviceId);
    if (action === "session") account.sessions.revokeSession(context.sessionId, "cor_stop");
    if (action === "source") writeFileSync(String(privateRecord(account, id).path), Buffer.alloc(3 * 64 * 1024, 0x74));
    if (action === "native") writeFileSync(join(root, "native-stop.jsonl"), "");
    await expect(blocks.next()).rejects.toThrow(action === "source" ? "ATTACHMENT_NOT_FOUND" : "SESSION_REVOKED");
    response.bodyStream!.close();
  } finally { account.close(); }
});

it("旧引用按需采用且不改变身份，真缺失和损坏继续显示不可用", async () => {
  const root = temporary(); const account = await createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }).openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_legacy", correlationId: "cor_legacy" }).conversationId;
    const media = new HistoryMedia(account.store, account.accountId);
    for (const state of ["available", "missing", "corrupt"]) {
      const bytes = Buffer.from("original"); const path = join(root, state); if (state !== "missing") writeFileSync(path, state === "corrupt" ? "modified" : bytes);
      const attachmentId = `media_legacy_${state}`; const key = `history-media:${attachmentId}`;
      const row = { attachmentId, conversationId: cid, messageId: `msg_${state}`, path, filename: state, mediaType: "application/octet-stream", sizeBytes: bytes.length, sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}` };
      account.store.database.prepare("INSERT INTO account_metadata(key,value) VALUES (?,?)").run(key, account.store.sealJson(row, key));
      expect(media.metadata(cid, attachmentId, "stream-v1")).toMatchObject({ attachmentId, remoteAvailable: state === "available" });
      if (state === "available") { expect(String(privateRecord(account, attachmentId).path)).toContain("/history-media/"); renameSync(path, path + ".retired"); expect(media.metadata(cid, attachmentId, "stream-v1").remoteAvailable).toBe(true); }
    }
  } finally { account.close(); }
});

it("真实 Ed25519 HTTP 返回原类型和摘要，JSON 原件与非法 MIME 均不混淆", async () => {
  const root = temporary(); const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }); const account = await core.openGatewayAccount(context.accountId);
  const keys = generateKeyPairSync("ed25519");
  account.credentials.setPassword("isolated-fixture");
  const login = account.sessions.createPasswordSession({ username: "fixture", password: "isolated-fixture", installation: { installationId: "install_real", displayName: "fixture", devicePublicKey: keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url") }, correlationId: "cor_real" });
  const routes = createGatewayRoutes({ core, hostVersion: "2026.7.1-2", verifyRequest: createGatewayRequestVerifier(core) });
  const route = routes.find(item => item.path === "/open-android-intelligence/v2/conversations/")!;
  const server = createServer((request, response) => { void Promise.resolve(route.handler(request, response)).catch(error => response.destroy(error)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); if (!address || typeof address === "string") throw new Error("fixture listen failed");
  const request = (method: "GET" | "POST", target: string) => {
    const body = method === "POST" ? Buffer.from("{}") : Buffer.alloc(0); const requestId = `req_${randomUUID()}`; const timestamp = new Date().toISOString(); const nonce = randomBytes(16).toString("base64url");
    const signature = sign(null, canonicalRequestSignatureInput({ method, target, accountId: context.accountId, deviceId: login.deviceId, sessionId: login.sessionId, requestId, timestamp, nonce, body }), keys.privateKey).toString("base64url");
    return fetch(`http://127.0.0.1:${address.port}${target}`, { method, ...(method === "POST" ? { body } : {}), headers: { authorization: `Bearer ${login.accessToken}`, "content-type": "application/json", "idempotency-key": requestId, ...Object.fromEntries(Object.entries({ protocol: "2.1", account: context.accountId, device: login.deviceId, session: login.sessionId, "request-id": requestId, timestamp, nonce, signature }).map(([key, value]) => [`x-open-android-intelligence-${key}`, value])) } });
  };
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_http", correlationId: "cor_http" }).conversationId;
    const media = new HistoryMedia(account.store, account.accountId);
    const json = join(root, "original.json"); writeFileSync(json, '{"original":true}');
    const large = join(root, "large.bin"); const fd = openSync(large, "wx"); const block = Buffer.alloc(64 * 1024, 0x72); const expected = createHash("sha256");
    for (let n = 0; n < 600; n += 1) { writeSync(fd, block); expected.update(block); } closeSync(fd);
    const references = [media.register(cid, "msg_json", json, "application/json", [root]), media.register(cid, "msg_large_http", large, "application/x-agent", [root])];
    for (const [index, part] of references.entries()) {
      const prefix = `/open-android-intelligence/v2/conversations/${cid}/attachments/${part.attachmentId}`;
      const metadata = await request("GET", prefix + "/metadata?format=stream-v1"); expect(metadata.status).toBe(200); expect((await metadata.json() as any).data.metadata.remoteAvailable).toBe(true);
      const grant = await request("POST", prefix + "/cache-grant?format=stream-v1"); expect(grant.status).toBe(200); const token = (await grant.json() as any).data.grantId;
      const content = await request("GET", prefix + `/content?format=stream-v1&grantId=${token}`);
      expect(content.status).toBe(200); expect(content.headers.get("x-open-android-intelligence-media-format")).toBe("stream-v1"); expect(content.headers.get("content-type")).toBe(part.mediaType);
      let length = 0; const received = createHash("sha256"); for await (const value of content.body!) { length += value.length; received.update(value); }
      const digest = received.digest("hex"); expect(length).toBe(part.sizeBytes); expect(content.headers.get("digest")).toBe(`sha-256=${Buffer.from(digest, "hex").toString("base64")}`);
      expect(digest).toBe(index === 0 ? createHash("sha256").update(readFileSync(json)).digest("hex") : expected.digest("hex"));
    }
    const bad = media.register(cid, "msg_bad_mime", json, "application/json\r\nX-Forged: yes", [root]);
    const oldPrefix = `/open-android-intelligence/v2/conversations/${cid}/attachments/${references[0]!.attachmentId}`;
    const oldGrant = await request("POST", oldPrefix + "/cache-grant"); const oldToken = (await oldGrant.json() as any).data.grantId;
    const oldContent = await request("GET", oldPrefix + `/content?grantId=${oldToken}`);
    expect(oldContent.headers.get("x-open-android-intelligence-media-format")).toBeNull();
    expect(Buffer.from((await oldContent.json() as any).data.contentBase64, "base64").toString()).toBe('{"original":true}');
    const prefix = `/open-android-intelligence/v2/conversations/${cid}/attachments/${bad.attachmentId}`;
    const grant = await request("POST", prefix + "/cache-grant?format=stream-v1"); const token = (await grant.json() as any).data.grantId;
    const failed = await request("GET", prefix + `/content?format=stream-v1&grantId=${token}`);
    expect(failed.status).toBe(400); expect(failed.headers.get("x-forged")).toBeNull(); expect((await failed.json() as any).error.code).toBe("SCHEMA_INVALID");
  } finally { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); account.close(); }
});

const inboundRuntime = (root: string, deliver: (turn: any, params: any) => Promise<void>): OpenClawInboundRuntime => {
  const store = join(root, "sessions.json"); writeFileSync(store, JSON.stringify({})); writeFileSync(join(root, "native.jsonl"), "");
  return {
    inbound: { buildContext: facts => facts, toInboundMediaFacts: media => media, run: async params => { const input = params as any; const normalized = await input.adapter.ingest(input.raw); const preflight = await input.adapter.preflight(normalized); const turn = await input.adapter.resolveTurn(normalized, {}, preflight); await turn.recordInboundSession(); await input.onTurnAdopted(); await deliver(turn, input); return { dispatched: true }; } },
    routing: { resolveAgentRoute: () => ({ agentId: "main", accountId: "default", sessionKey: "agent:main:history" }) },
    session: { resolveStorePath: () => store, recordInboundSession: async input => { const session = input as {sessionKey:string}; writeFileSync(store,JSON.stringify({[session.sessionKey]:{sessionId:"native",sessionFile:"native.jsonl"}})); } },
    reply: { dispatchReplyWithBufferedBlockDispatcher: () => undefined },
  };
};

it("真实 Agent 附件回调发出事件后退休源，HTTP 原件和历史 parts 仍一致，删除后不复活", async () => {
  const root = temporary(); const path = join(root, "reply.png"); writeFileSync(path, "agent-image");
  const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }); const account = await core.openGatewayAccount(context.accountId);
  try {
    installSession(account); const cid = account.conversations.create({ clientConversationId: "cc_outbound", correlationId: "cor_outbound" }).conversationId;
    account.conversations.acceptMessage({ conversationId: cid, clientMessageId: "cm_outbound", text: "image", attachmentIds: [], deviceId: context.deviceId, requestId: "req_outbound", correlationId: "cor_outbound" }); const message = account.conversations.claimNextMessage()!;
    const runtime = inboundRuntime(root, async turn => { await turn.delivery.deliver({ mediaUrl: path, mediaType: "image/png" }); renameSync(path, path + ".retired"); writeFileSync(join(root, "native.jsonl"), JSON.stringify({ type: "message", id: "answer", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "image", path }] } }) + "\n"); });
    await dispatchGatewayMessageToOpenClaw({ account, message, channelRuntime: runtime, cfg: { agents: { defaults: { workspace: root } } }, gatewayAccountId: account.accountId, channelAccountId: "default" });
    const event = account.events.readAfter(null).find(item => item.eventType === "conversation.message.completed")!; expect(event).toBeDefined();
    const rows = (await account.conversations.listMessages(cid)).messages as any[]; const reply = rows.find(row => row.sender === "assistant"); expect(reply.parts).toEqual(event.payload.parts); expect(reply.parts).toHaveLength(1);
    const id = String(reply.parts[0].attachmentId); const media = new HistoryMedia(account.store, account.accountId); expect(media.register(cid, reply.messageId, path, "image/png", [root])).toEqual(reply.parts[0]);
    const grant = String(media.grant(cid, id, context, undefined, "stream-v1").grantId); const response = await core.handle({ context, method: "GET", target: `/open-android-intelligence/v2/conversations/${cid}/attachments/${id}/content?format=stream-v1&grantId=${grant}` });
    const chunks: Uint8Array[] = []; for await (const chunk of response.bodyStream!.chunks()) chunks.push(chunk); expect(Buffer.concat(chunks).toString()).toBe("agent-image");
    writeFileSync(join(root, "native.jsonl"), ""); expect(((await account.conversations.listMessages(cid)).messages as any[]).find(row => row.messageId === reply.messageId).state).toBe("DELETED"); expect(media.metadata(cid, id, "stream-v1").remoteAvailable).toBe(false);
    expect(() => media.register(cid, reply.messageId, path, "image/png", [root])).toThrow("ATTACHMENT_NOT_FOUND");
  } finally { account.close(); }
});

it("用户上传采用完成后才 ACK，暂存清理后仍保留原始身份、历史卡片和可读原件", async () => {
  const root = temporary(); const core = createGatewayCore({ storageRoot: root, attachmentMasterKey: Buffer.alloc(32, 0x41) }); const account = await core.openGatewayAccount(context.accountId);
  try {
    const cid = account.conversations.create({ clientConversationId: "cc_inbound", correlationId: "cor_inbound" }).conversationId;
    const bytes = Buffer.from("user-original"); const attachment = account.attachments.create({ clientAttachmentId: "ca_user", filename: "selected.png", mediaType: "image/png", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), correlationId: "cor_upload" }); await account.attachments.uploadContent(attachment.attachmentId, bytes); account.attachments.commit(attachment.attachmentId);
    account.conversations.acceptMessage({ conversationId: cid, clientMessageId: "cm_user", text: "", attachmentIds: [attachment.attachmentId], deviceId: context.deviceId, requestId: "req_user", correlationId: "cor_user" }); const message = account.conversations.claimNextMessage()!;
    const runtime = inboundRuntime(root, async (_turn, params) => { expect(readFileSync(params.raw.media[0].path)).toEqual(bytes); });
    await dispatchGatewayMessageToOpenClaw({ account, message, channelRuntime: runtime, cfg: {}, gatewayAccountId: account.accountId, channelAccountId: "default" });
    expect(account.attachments.get(attachment.attachmentId)).toMatchObject({ state: "acknowledged", hasStagedBytes: false });
    const row = ((await account.conversations.listMessages(cid)).messages as any[]).find(item => item.messageId === message.messageId);
    expect(row.parts).toEqual([{ type: "attachment", attachmentId: attachment.attachmentId, filename: attachment.filename, mediaType: attachment.mediaType, sizeBytes: bytes.length }]);
    const media = new HistoryMedia(account.store, account.accountId); expect(media.metadata(cid, attachment.attachmentId, "stream-v1").remoteAvailable).toBe(true); const token = String(media.grant(cid, attachment.attachmentId, context).grantId); expect(Buffer.from(media.content(cid, attachment.attachmentId, token, context).body)).toEqual(bytes);
  } finally { account.close(); }
});
