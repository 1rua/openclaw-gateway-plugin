import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";
import { CredentialStore } from "./credential-store.js";
import type { EventStore } from "./event-store.js";

export type LoginInstallation = Readonly<{
  installationId: string;
  displayName: string;
  devicePublicKey: string;
}>;

export type SessionBundle = Readonly<{
  sessionId: string;
  deviceId: string;
  accessToken: string;
  refreshCredential: string;
  expiresAt: string;
}>;

/**
 * The verified-request facts behind one live access session.
 *
 * A host that implements Ed25519 request verification resolves the device public
 * key and the pairing/grant revisions from here, so the key a request is checked
 * against is always the key the login recorded.
 */
export type SessionFacts = Readonly<{
  sessionId: string;
  installationId: string;
  devicePublicKey: string;
  pairingGeneration: number;
  grantRevision: number;
}>;

/**
 * The lifecycle state of one access session row, read without the access token.
 *
 * The unpair endpoint needs it: it is the only way this host can tell an
 * already-revoked session from an expired one, which the contract reports as
 * two different wire codes.
 */
export type SessionState =
  | Readonly<{ kind: "active" }>
  | Readonly<{ kind: "expired" }>
  | Readonly<{ kind: "revoked" }>
  | Readonly<{ kind: "unknown" }>;

/**
 * A host may replace how a password is checked; the default verifies the digest
 * the local admin surface recorded for this account.
 */
export type CredentialVerifier = (input: Readonly<{
  accountId: string;
  username: string;
  password: string;
  installation: LoginInstallation;
}>) => boolean;

const digestSecret = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const sameDigest = (left: string, right: string): boolean => {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

const secret = (prefix: string): string => `${prefix}_${randomBytes(32).toString("base64url")}`;

const nowIso = (now = new Date()): string => now.toISOString();

export class SessionService {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
    private readonly events: EventStore,
    private readonly credentials: CredentialStore,
    private readonly credentialVerifier?: CredentialVerifier,
  ) {}

  createPasswordSession(input: Readonly<{
    username: string;
    password: string;
    installation: LoginInstallation;
    correlationId: string;
    now?: Date;
  }>): SessionBundle {
    // Contract §5.1: the username is a mutable login name and never the
    // isolation key, so it is not compared with the account id here. What makes
    // this account's login succeed is its recorded password digest.
    if (typeof input.username !== "string" || input.username.trim().length === 0) {
      throw new Error("AUTHENTICATION_FAILED");
    }
    if (!this.installationIsComplete(input.installation)) {
      throw new Error("AUTHENTICATION_FAILED");
    }
    const verified = this.credentialVerifier !== undefined
      ? this.credentialVerifier({
          accountId: this.accountId,
          username: input.username,
          password: input.password,
          installation: input.installation,
        })
      : this.credentials.verifyPassword(input.password);
    if (verified !== true) throw new Error("AUTHENTICATION_FAILED");

    return this.store.transaction(() => {
      const bundle = this.issue(input.installation.installationId, `dev_${randomUUID()}`, input.now);
      this.registerDeviceKey(bundle.deviceId, input.installation, input.now);
      this.audit.append({
        eventType: "session.password.created",
        actor: { accountId: this.accountId, deviceId: bundle.deviceId, installationId: input.installation.installationId },
        subject: { method: "password", displayName: input.installation.displayName },
        correlationId: input.correlationId,
        occurredAt: nowIso(input.now),
      });
      return bundle;
    });
  }

  refresh(input: Readonly<{
    refreshCredential: string;
    installationId: string;
    deviceId: string;
    correlationId: string;
    now?: Date;
  }>): SessionBundle {
    return this.store.transaction(() => {
      const credentialHash = digestSecret(input.refreshCredential);
      const row = this.store.database
        .prepare("SELECT * FROM refresh_credentials WHERE credential_hash = ?")
        .get(credentialHash) as Record<string, unknown> | undefined;
      if (
        row === undefined ||
        String(row.installation_id) !== input.installationId ||
        String(row.device_id) !== input.deviceId
      ) {
        throw new Error("AUTHENTICATION_FAILED");
      }
      if (String(row.status) !== "active") {
        this.recordRefreshReuse(input);
      }

      const bundle = this.issue(input.installationId, input.deviceId, input.now);
      this.store.database
        .prepare("UPDATE refresh_credentials SET status = 'used', replaced_by_hash = ? WHERE credential_hash = ?")
        .run(digestSecret(bundle.refreshCredential), credentialHash);
      this.audit.append({
        eventType: "session.refresh.rotated",
        actor: { accountId: this.accountId, deviceId: input.deviceId, installationId: input.installationId },
        subject: { rotated: true },
        correlationId: input.correlationId,
        occurredAt: nowIso(input.now),
      });
      return bundle;
    });
  }

  /**
   * Resolves one live access session to the facts a verifier needs.
   *
   * Returns undefined instead of throwing: the caller is an authentication seam
   * that must fail closed without telling the requester which check failed.
   */
  resolveSession(
    accessToken: string,
    sessionId: string,
    deviceId: string,
    now = new Date(),
  ): SessionFacts | undefined {
    const row = this.store.database
      .prepare(`
        SELECT s.session_id AS session_id, s.installation_id AS installation_id,
               s.status AS status, s.expires_at AS expires_at,
               s.access_token_hash AS access_token_hash,
               k.public_key AS public_key,
               k.pairing_generation AS pairing_generation,
               k.grant_revision AS grant_revision
        FROM access_sessions s
        LEFT JOIN device_keys k ON k.device_id = s.device_id
        WHERE s.session_id = ? AND s.device_id = ?
      `)
      .get(sessionId, deviceId) as Record<string, unknown> | undefined;
    if (row === undefined || String(row.status) !== "active") return undefined;
    if (Date.parse(String(row.expires_at)) <= now.getTime()) return undefined;

    const storedHash = row.access_token_hash;
    if (typeof storedHash !== "string" || !sameDigest(storedHash, digestSecret(accessToken))) {
      return undefined;
    }
    const publicKey = row.public_key;
    if (typeof publicKey !== "string" || publicKey.length === 0) return undefined;
    return Object.freeze({
      sessionId: String(row.session_id),
      installationId: String(row.installation_id),
      devicePublicKey: publicKey,
      pairingGeneration: Number(row.pairing_generation ?? 1),
      grantRevision: Number(row.grant_revision ?? 1),
    });
  }

  verifyAccessToken(
    accessToken: string,
    sessionId: string,
    deviceId: string,
    now = new Date(),
  ): boolean {
    return this.resolveSession(accessToken, sessionId, deviceId, now) !== undefined;
  }

  revokeSession(sessionId: string, correlationId: string, now = new Date()): void {
    this.store.transaction(() => {
      // The device id is read from the session row itself: the event payload
      // carries the real pairing the session belonged to, never a caller's
      // claim. A missing row means nothing was revoked, so the stream must not
      // carry a fabricated revocation — the audit line keeps its pre-existing
      // behavior either way.
      const row = this.store.database
        .prepare("SELECT device_id AS device_id FROM access_sessions WHERE session_id = ?")
        .get(sessionId) as Record<string, unknown> | undefined;
      this.store.database
        .prepare("UPDATE access_sessions SET status = 'revoked' WHERE session_id = ?")
        .run(sessionId);
      this.audit.append({
        eventType: "session.revoked",
        actor: { accountId: this.accountId },
        subject: { sessionId },
        correlationId,
        occurredAt: nowIso(now),
      });
      if (row === undefined) return;
      this.events.append({
        eventType: "session.revoked",
        correlationId,
        payload: { sessionId, deviceId: String(row.device_id) },
        now,
      });
    });
  }

  /**
   * Ends the *login*: the device can no longer mint a new access token from its
   * refresh credential.
   *
   * This is contract §13 "退出登录" and deliberately stops short of the pairing:
   * the device key survives so the phone can still prove who it is and sign a
   * fresh login without re-pairing. Removing the key is 解除配对, which is a
   * separate resource-level transaction served by `DELETE /pairings/current`
   * (D1) and never implied by a session delete (§5.5).
   */
  revokeRefreshCredentials(deviceId: string, correlationId: string, now = new Date()): void {
    this.store.transaction(() => {
      this.store.database
        .prepare("UPDATE refresh_credentials SET status = 'revoked' WHERE device_id = ? AND status = 'active'")
        .run(deviceId);
      this.audit.append({
        eventType: "session.refresh.revoked",
        actor: { accountId: this.accountId, deviceId },
        subject: {},
        correlationId,
        occurredAt: nowIso(now),
      });
    });
  }

  activeRefreshCredentialCount(deviceId: string): number {
    const row = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM refresh_credentials WHERE device_id = ? AND status = 'active'")
      .get(deviceId) as { count: number };
    return row.count;
  }

  activeSessionCount(deviceId: string): number {
    const row = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM access_sessions WHERE device_id = ? AND status = 'active'")
      .get(deviceId) as { count: number };
    return row.count;
  }

  /**
   * Ends every access session of one device, not just the caller's.
   *
   * 解除配对 has to cut a device off completely: contract §13 lists the five
   * resource classes and D1 adds "every access session of the device", so a
   * second session the phone still holds cannot stay usable.
   */
  revokeDeviceSessions(deviceId: string, correlationId: string, now = new Date()): number {
    return this.store.transaction(() => {
      const revoked = this.store.database
        .prepare("UPDATE access_sessions SET status = 'revoked' WHERE device_id = ? AND status = 'active'")
        .run(deviceId) as { changes: number };
      this.audit.append({
        eventType: "session.revoked",
        actor: { accountId: this.accountId, deviceId },
        subject: { scope: "device", revoked: revoked.changes },
        correlationId,
        occurredAt: nowIso(now),
      });
      return revoked.changes;
    });
  }

  describeSession(sessionId: string, deviceId: string, now = new Date()): SessionState {
    const row = this.store.database
      .prepare("SELECT status AS status, expires_at AS expires_at FROM access_sessions WHERE session_id = ? AND device_id = ?")
      .get(sessionId, deviceId) as Record<string, unknown> | undefined;
    if (row === undefined) return Object.freeze({ kind: "unknown" as const });
    if (String(row.status) !== "active") return Object.freeze({ kind: "revoked" as const });
    if (Date.parse(String(row.expires_at)) <= now.getTime()) {
      return Object.freeze({ kind: "expired" as const });
    }
    return Object.freeze({ kind: "active" as const });
  }

  /** The pairing generation the next device key of this account will carry. */
  currentPairingGeneration(): number {
    const row = this.store.database
      .prepare("SELECT value FROM account_metadata WHERE key = 'pairing_generation'")
      .get() as { value: string } | undefined;
    const parsed = Number(row?.value ?? 1);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
  }

  private installationIsComplete(installation: LoginInstallation): boolean {
    return typeof installation === "object" && installation !== null
      && typeof installation.installationId === "string" && installation.installationId.length > 0
      && typeof installation.devicePublicKey === "string" && installation.devicePublicKey.length > 0;
  }

  private registerDeviceKey(
    deviceId: string,
    installation: LoginInstallation,
    now?: Date,
  ): void {
    // The key is what makes a later request signature checkable, so it is
    // written in the same transaction that issues the session: a session whose
    // key was never recorded cannot be used. The generation comes from the
    // account counter, so a re-pair after 解除配对 starts *above* the
    // generation the pairing was revoked at (contract §12) instead of at 1.
    this.store.database
      .prepare(`
        INSERT INTO device_keys(device_id, installation_id, public_key, pairing_generation, grant_revision, registered_at)
        VALUES (?, ?, ?, ?, 1, ?)
        ON CONFLICT(device_id) DO UPDATE SET
          installation_id = excluded.installation_id,
          public_key = excluded.public_key,
          registered_at = excluded.registered_at
      `)
      .run(
        deviceId,
        installation.installationId,
        installation.devicePublicKey,
        this.currentPairingGeneration(),
        nowIso(now),
      );
  }

  private recordRefreshReuse(input: Readonly<{
    installationId: string;
    deviceId: string;
    correlationId: string;
    now?: Date;
  }>): never {
    this.store.database
      .prepare("UPDATE refresh_credentials SET status = 'revoked' WHERE installation_id = ? AND device_id = ?")
      .run(input.installationId, input.deviceId);
    this.audit.append({
      eventType: "session.refresh.reused",
      actor: { accountId: this.accountId, deviceId: input.deviceId, installationId: input.installationId },
      subject: { reused: true },
      correlationId: input.correlationId,
      occurredAt: nowIso(input.now),
    });
    this.store.database.exec("COMMIT");
    throw new Error("REFRESH_REUSED");
  }

  private issue(installationId: string, deviceId: string, now = new Date()): SessionBundle {
    const sessionId = `sess_${randomUUID()}`;
    const accessToken = secret("access");
    const refreshCredential = secret("refresh");
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
    this.store.database
      .prepare(`
        INSERT INTO access_sessions(session_id, installation_id, device_id, status, created_at, expires_at)
        VALUES (?, ?, ?, 'active', ?, ?)
      `)
      .run(sessionId, installationId, deviceId, createdAt, expiresAt);
    // The token itself is never stored: only its digest, so a database read
    // cannot produce a usable credential.
    this.store.database
      .prepare("UPDATE access_sessions SET access_token_hash = ? WHERE session_id = ?")
      .run(digestSecret(accessToken), sessionId);
    this.store.database
      .prepare(`
        INSERT INTO refresh_credentials(
          credential_hash, installation_id, device_id, session_id, status, created_at, replaced_by_hash
        )
        VALUES (?, ?, ?, ?, 'active', ?, NULL)
      `)
      .run(digestSecret(refreshCredential), installationId, deviceId, sessionId, createdAt);
    return Object.freeze({ sessionId, deviceId, accessToken, refreshCredential, expiresAt });
  }
}
