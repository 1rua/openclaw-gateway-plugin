import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { GatewayAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";

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

const digestSecret = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const secret = (prefix: string): string => `${prefix}_${randomBytes(32).toString("base64url")}`;

const nowIso = (now = new Date()): string => now.toISOString();

export class SessionService {
  constructor(
    private readonly accountId: string,
    private readonly store: GatewayAccountStore,
    private readonly audit: AuditStore,
  ) {}

  createPasswordSession(input: Readonly<{
    username: string;
    password: string;
    installation: LoginInstallation;
    correlationId: string;
    now?: Date;
  }>): SessionBundle {
    if (input.password.length === 0 || input.username.length === 0) {
      throw new Error("AUTHENTICATION_FAILED");
    }
    return this.store.transaction(() => {
      const bundle = this.issue(input.installation.installationId, `dev_${randomUUID()}`, input.now);
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

  activeRefreshCredentialCount(deviceId: string): number {
    const row = this.store.database
      .prepare("SELECT COUNT(*) AS count FROM refresh_credentials WHERE device_id = ? AND status = 'active'")
      .get(deviceId) as { count: number };
    return row.count;
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
