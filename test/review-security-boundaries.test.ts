import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { coreSchemaHash } from "../../../gateway-contract/src/core-schema-hash.js";
import { canonicalRequestSignatureInput } from "../../../gateway-contract/src/request-signature.js";
import vectors from "../../../gateway-contract/vectors/protocol-negotiation.json" with { type: "json" };
import { createGatewayCore } from "../src/core/gateway-core.js";
import { AccountPayloadCipher } from "../src/core/payload-cipher.js";
import { registerOpenAndroidIntelligenceGateway } from "../src/host/channel-adapter.js";

const root = () => mkdtempSync(join(tmpdir(), "oai-review-security-"));
const negotiation = (id = "neg_review") => {
  const body = structuredClone(vectors.cases[0]!.input.value!) as Record<string, any>;
  body.negotiationId = id;
  body.schemaHashes.core = coreSchemaHash();
  return body;
};
const now = new Date("2026-10-02T00:00:00.000Z");
const installation = { installationId: "install_1", displayName: "Phone", devicePublicKey: "A".repeat(43) };
afterEach(() => vi.restoreAllMocks());

describe("review security boundaries", () => {
  it("migrates legacy plaintext without leaving it in SQLite or WAL and retries an interrupted scrub", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    let account = await core.openGatewayAccount("alice");
    const conversation = account.conversations.create({ clientConversationId: "legacy_conv", correlationId: "cor_legacy" });
    const accepted = account.conversations.acceptMessage({ conversationId: conversation.conversationId, clientMessageId: "legacy_msg",
      text: "legacy-plaintext-marker-keep-this-message", attachmentIds: [], deviceId: "dev_1", requestId: "req_1", correlationId: "cor_legacy" });
    const databasePath = account.paths.database;
    for (const row of account.store.database.prepare("SELECT event_id,payload_json FROM events").all()) {
      account.store.database.prepare("UPDATE events SET payload_json = ? WHERE event_id = ?")
        .run(account.store.openString(String(row.payload_json), `event:${row.event_id}`), row.event_id);
    }
    account.store.database.prepare("UPDATE messages SET body = ?").run("legacy-plaintext-marker-keep-this-message");
    account.store.database.prepare("DELETE FROM account_metadata WHERE key = 'payload_storage_format'").run();
    account.store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    account.close();
    expect(readFileSync(databasePath).includes(Buffer.from("legacy-plaintext-marker"))).toBe(true);
    const reader = new DatabaseSync(databasePath);
    reader.exec("BEGIN"); reader.prepare("SELECT * FROM messages").all();
    try { await expect(core.openGatewayAccount("alice")).rejects.toThrow("PAYLOAD_MIGRATION_BUSY"); }
    finally { reader.exec("ROLLBACK"); reader.close(); }
    account = await core.openGatewayAccount("alice");
    expect(account.conversations.getMessage(accepted.messageId).text).toBe("legacy-plaintext-marker-keep-this-message");
    expect(account.store.database.prepare("SELECT 1 FROM account_metadata WHERE key = 'payload_scrub_pending'").get()).toBeUndefined();
    account.close();
    for (const path of [databasePath, databasePath + "-wal"]) {
      if (existsSync(path)) expect(readFileSync(path).includes(Buffer.from("legacy-plaintext-marker"))).toBe(false);
    }
  });

  it("rejects malformed device parameters before storing a queue row or event", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    const account = await core.openGatewayAccount("alice");
    const input = { requestId: "dr_invalid", deviceId: "dev_1", pairingGeneration: 1, grantRevision: 1, risk: "read" as const,
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" }, provider: { pluginId: "org.openandroidintelligence.sms", authorKeyId: "sha256:" + "a".repeat(64) },
      parameters: { limit: 1 }, correlationId: "cor_invalid", now };
    expect(() => account.deviceRequests.enqueue(input)).toThrow("SCHEMA_INVALID");
    expect(account.store.database.prepare("SELECT COUNT(*) AS count FROM device_requests").get()!.count).toBe(0);
    expect(account.events.readAfter(null, now)).toEqual([]);
    account.close();
  });

  it("bounds pending negotiation capacity, expires it and does not extend identical retries", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    const request = (id: string, time: Date) => core.handle({ method: "POST", target: "/open-android-intelligence/v2/negotiate", body: negotiation(id), now: time });
    for (let i = 0; i < 1000; i++) expect(await request(`neg_${i}`, now)).toHaveProperty("data");
    expect(await request("neg_over_capacity", new Date(+now + 61_000))).toMatchObject({ error: { code: "RATE_LIMITED" } });
    expect(await request("neg_over_capacity", new Date(+now + 300_001))).toHaveProperty("data");

    const account = await core.openGatewayAccount("alice");
    account.credentials.createPassword("correct password");
    account.close();
    expect(await request("neg_retry", new Date(+now + 400_000))).toHaveProperty("data");
    expect(await request("neg_retry", new Date(+now + 640_000))).toHaveProperty("data");
    expect(await core.handle({ method: "POST", target: "/open-android-intelligence/v2/sessions/password", now: new Date(+now + 700_001),
      body: { negotiationId: "neg_retry", username: "alice", password: "correct password", installation } })).toMatchObject({ error: { code: "PROTOCOL_INCOMPATIBLE" } });
  });

  it("admits at most two asynchronous password checks while allowing the event loop to run", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    const account = await core.openGatewayAccount("alice");
    account.credentials.createPassword("correct password");
    account.close();
    await core.handle({ method: "POST", target: "/open-android-intelligence/v2/negotiate", body: negotiation(), now });
    const login = () => core.handle({ method: "POST", target: "/open-android-intelligence/v2/sessions/password", now,
      body: { negotiationId: "neg_review", username: "alice", password: "correct password", installation } });
    let completed = false;
    const first = login().then(value => { completed = true; return value; });
    const second = login();
    expect(await login()).toMatchObject({ error: { code: "RATE_LIMITED" } });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(completed).toBe(false);
    expect(await first).toHaveProperty("data.accessToken");
    expect(await second).toHaveProperty("data.accessToken");
  });

  it("requires a real configured TLS identity and represents explicit plaintext without a fabricated pin", async () => {
    const storageRoot = root();
    const request = { method: "POST" as const, target: "/open-android-intelligence/v2/negotiate", body: negotiation() };
    expect(await createGatewayCore({ storageRoot }).handle(request)).toMatchObject({ data: { gatewayIdentity: { tlsSpkiSha256: null } } });
    const pin = "sha256:" + "b".repeat(64);
    expect(await createGatewayCore({ storageRoot, tlsSpkiSha256: pin }).handle(request)).toMatchObject({ data: { gatewayIdentity: { tlsSpkiSha256: pin } } });
    expect(() => createGatewayCore({ tlsSpkiSha256: "sha256:" + "0".repeat(64) })).toThrow("GATEWAY_TLS_IDENTITY_INVALID");
  });

  it("binds authenticated ciphertext to the account and row, refuses tampering and erases keys on close", () => {
    const key = Buffer.alloc(32, 0x48);
    const alice = new AccountPayloadCipher(key, "alice"), bob = new AccountPayloadCipher(key, "bob");
    const sealed = alice.seal("private review marker", "message:one");
    expect(alice.open(sealed, "message:one")).toBe("private review marker");
    expect(() => bob.open(sealed, "message:one")).toThrow();
    expect(() => alice.open(sealed, "message:two")).toThrow();
    const bytes = Buffer.from(sealed.slice(8), "base64url"); bytes[bytes.length - 1]! ^= 1;
    expect(() => alice.open("aead-v1:" + bytes.toString("base64url"), "message:one")).toThrow();
    alice.close(); expect(() => alice.open(sealed, "message:one")).toThrow(); bob.close();
  });

  it("stores event and device input/result ciphertext, then physically purges expired or ACKed content", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    const account = await core.openGatewayAccount("alice");
    const event = account.events.append({ eventType: "conversation.message.completed", correlationId: "cor_review", now,
      payload: { conversationId: "conv_review", messageId: "msg_review", sender: "assistant", parts: [{ type: "text", text: "private-event-marker" }], text: "private-event-marker", timestamp: +now, revision: 1 } });
    account.deviceRequests.enqueue({ requestId: "dr_review", deviceId: "dev_review", pairingGeneration: 1, grantRevision: 1, risk: "read",
      capability: { id: "org.openandroidintelligence.sms.query", version: "1.0.0" }, provider: { pluginId: "org.openandroidintelligence.sms", authorKeyId: "sha256:" + "a".repeat(64) },
      parameters: { query: "private-input-marker" }, correlationId: "cor_device", now });
    const receipt = account.deviceRequests.claim({ requestId: "dr_review", deviceId: "dev_review", pairingGeneration: 1, grantRevision: 1, correlationId: "cor_claim", now });
    account.deviceRequests.submitResult({ ...receipt, correlationId: "cor_result", now, result: { outcome: "succeeded", data: { marker: "private-result-marker" } } });
    const row = account.store.database.prepare("SELECT parameters_json, result_json FROM device_requests").get()!;
    expect(row.parameters_json).toBe(""); expect(String(row.result_json)).toMatch(/^aead-v1:/);
    expect(account.deviceRequests.readResult("dr_review", receipt.claimId, now)).toMatchObject({ data: { marker: "private-result-marker" } });
    account.store.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    expect(readFileSync(account.paths.database).includes(Buffer.from("private-event-marker"))).toBe(false);
    expect(readFileSync(account.paths.database).includes(Buffer.from("private-result-marker"))).toBe(false);
    account.deviceRequests.acknowledgeResult("dr_review", receipt.claimId);
    expect(account.deviceRequests.readResult("dr_review", receipt.claimId, now)).toBeUndefined();
    expect(account.events.readAfter(null, new Date(+now + 86_400_001))).toEqual([]);
    expect(account.store.database.prepare("SELECT COUNT(*) AS n FROM events").get()!.n).toBe(0);
    expect(() => account.events.readAfter(event.eventId, new Date(+now + 86_400_001))).toThrow("CURSOR_EXPIRED");
    account.close();
  });

  it("uses the real SDK runtime.version shape and the Gateway's own verifier on raw HTTP", async () => {
    const core = createGatewayCore({ storageRoot: root(), attachmentMasterKey: Buffer.alloc(32, 0x48) });
    const account = await core.openGatewayAccount("alice");
    const keys = generateKeyPairSync("ed25519");
    const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64url");
    account.credentials.createPassword("password");
    const session = account.sessions.createPasswordSession({ username: "alice", password: "password", installation: { ...installation, devicePublicKey: publicKey }, correlationId: "cor_http" });
    account.close();
    const routes: Array<{ path: string; handler: (req: IncomingMessage, res: ServerResponse) => unknown }> = [];
    registerOpenAndroidIntelligenceGateway({ version: "plugin-only", runtime: { version: "2026.7.1" }, gatewayCore: core,
      registerChannel: () => undefined, registerHttpRoute: route => routes.push(route as typeof routes[number]) });
    const route = routes.find(route => route.path === "/open-android-intelligence/v2/conversations")!;
    expect(route).toBeDefined();
    const server = createServer((req, res) => { Promise.resolve(route.handler(req, res)).catch(() => { res.statusCode = 500; res.end(); }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const target = route.path;
      const signed = { method: "GET" as const, target, accountId: "alice", deviceId: session.deviceId, sessionId: session.sessionId, requestId: "req_http", timestamp: new Date().toISOString(), nonce: randomBytes(16).toString("base64url"), body: Buffer.alloc(0) };
      const signature = sign(null, canonicalRequestSignatureInput(signed), keys.privateKey).toString("base64url");
      const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}`, "x-open-android-intelligence-protocol": "2.1" };
      for (const [name, value] of Object.entries({ account: signed.accountId, device: signed.deviceId, session: signed.sessionId, "request-id": signed.requestId, timestamp: signed.timestamp, nonce: signed.nonce, signature })) headers[`x-open-android-intelligence-${name}`] = value;
      const url = `http://127.0.0.1:${(server.address() as { port: number }).port}${target}`;
      expect((await fetch(url, { headers })).status).toBe(200);
      expect((await fetch(url, { headers })).status).toBe(401); // persisted nonce replay
      expect((await fetch(url, { headers: { ...headers, "x-open-android-intelligence-signature": "A".repeat(86) } })).status).toBe(401);
      expect((await fetch(url, { headers: { ...headers, "x-open-android-intelligence-account": "bob" } })).status).toBe(401);
      expect(core.accountExists("bob")).toBe(false);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });
});
