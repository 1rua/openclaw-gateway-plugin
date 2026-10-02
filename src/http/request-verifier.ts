import { createHash, createPublicKey, verify } from "node:crypto";
import { canonicalRequestSignatureInput } from "../../../../gateway-contract/src/request-signature.js";
import type { GatewayCore } from "../core/gateway-core.js";
import type { GatewayRequestVerifier } from "./routes.js";

/** Gateway authentication belongs to the plugin; OpenClaw supplies raw HTTP only. */
export const createGatewayRequestVerifier = (core: GatewayCore): GatewayRequestVerifier => async (input) => {
  let account: Awaited<ReturnType<GatewayCore["openGatewayAccount"]>> | undefined;
  try {
    const headers = new Map<string, string>();
    const singletons = new Set(["authorization", "content-length", "content-type", "digest", "last-event-id", "idempotency-key", "transfer-encoding", "content-encoding"]);
    for (let index = 0; index < input.rawHeaders.length; index += 2) {
      const name = input.rawHeaders[index]!.toLowerCase(), value = input.rawHeaders[index + 1];
      if (value === undefined || /[\r\n]/.test(value)) return undefined;
      if (headers.has(name) && (singletons.has(name) || name.startsWith("x-open-android-intelligence-"))) return undefined;
      headers.set(name, value);
    }
    const field = (name: string): string => headers.get(`x-open-android-intelligence-${name}`) ?? "";
    if (field("protocol") !== "2.1") return undefined;
    const authorization = headers.get("authorization");
    if (!authorization?.startsWith("Bearer ") || authorization.slice(7).trim() !== authorization.slice(7)) return undefined;
    const now = new Date();
    if (Math.abs(now.getTime() - Date.parse(field("timestamp"))) > 120_000) return undefined;
    const signed = { method: input.method, target: input.target, accountId: field("account"), deviceId: field("device"), sessionId: field("session"), requestId: field("request-id"), timestamp: field("timestamp"), nonce: field("nonce"), body: input.body };
    let preimage = canonicalRequestSignatureInput(signed);
    if (input.declaredBodyDigestHex !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(input.declaredBodyDigestHex)) return undefined;
      const lines = new TextDecoder().decode(preimage).split("\n");
      lines[lines.length - 1] = input.declaredBodyDigestHex;
      preimage = new TextEncoder().encode(lines.join("\n"));
    }
    const signature = field("signature");
    if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature, "base64url").toString("base64url") !== signature) return undefined;
    if (!core.accountExists?.(signed.accountId)) return undefined;
    account = await core.openGatewayAccount(signed.accountId);
    const facts = account.sessions.resolveSession(authorization.slice(7), signed.sessionId, signed.deviceId, now);
    if (facts === undefined) return undefined;
    const keyBytes = Buffer.from(facts.devicePublicKey, "base64url");
    if (keyBytes.byteLength !== 32 || keyBytes.toString("base64url") !== facts.devicePublicKey) return undefined;
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), keyBytes]), type: "spki", format: "der" });
    if (!verify(null, preimage, key, Buffer.from(signature, "base64url"))) return undefined;
    const body = input.declaredBodyDigestHex !== undefined || input.body.byteLength === 0 ? undefined : JSON.parse(Buffer.from(input.body).toString("utf8"));
    account.store.transaction(() => {
      account!.store.database.prepare("DELETE FROM request_nonces WHERE expires_at <= ?").run(now.toISOString());
      const count = account!.store.database.prepare("SELECT COUNT(*) AS count FROM request_nonces").get() as { count: number };
      if (count.count >= 10000) throw new Error("RATE_LIMITED");
      account!.store.database.prepare("INSERT INTO request_nonces(device_id, nonce_hash, expires_at) VALUES (?, ?, ?)")
        .run(signed.deviceId, createHash("sha256").update(signed.nonce).digest("hex"), new Date(now.getTime() + 240_000).toISOString());
    });
    return {
      method: signed.method, target: signed.target, body, now,
      context: { accountId: signed.accountId, deviceId: signed.deviceId, sessionId: signed.sessionId, requestId: signed.requestId, correlationId: signed.requestId, pairingGeneration: facts.pairingGeneration, grantRevision: facts.grantRevision },
      ...(headers.has("idempotency-key") ? { idempotencyKey: headers.get("idempotency-key")! } : {}),
      ...(headers.has("last-event-id") ? { lastEventId: headers.get("last-event-id")! } : {}),
    };
  } catch { return undefined; }
  finally { account?.close(); }
};
