import type { GatewayAccountStore } from "./account-store.js";
import { hashPassword, verifyPassword, verifyPasswordAsync } from "./credentials.js";

export const PASSWORD_CREDENTIAL_ID = "password";

/**
 * The account password digest, stored beside the account it protects.
 *
 * An account with no recorded digest cannot be logged into: there is no
 * fallback that accepts an arbitrary password.
 */
export class CredentialStore {
  constructor(private readonly store: GatewayAccountStore) {}

  setPassword(password: string, now = new Date()): void {
    this.writePassword(password, now, false);
  }

  createPassword(password: string, now = new Date()): void {
    this.writePassword(password, now, true);
  }

  private writePassword(password: string, now: Date, createOnly: boolean): void {
    const digest = hashPassword(password);
    this.store.transaction(() => {
      const exists = this.hasPassword();
      if (exists && createOnly) throw new Error("ACCOUNT_EXISTS");
      this.store.database
      .prepare(`
        INSERT INTO account_credentials(credential_id, password_hash, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          password_hash = excluded.password_hash, updated_at = excluded.updated_at
      `)
      .run(PASSWORD_CREDENTIAL_ID, digest, now.toISOString());
      // A password reset reclaims every refresh family, including rotated
      // credentials on other devices. Pairing keys and access sessions remain.
      if (exists) this.store.database.prepare("UPDATE refresh_credentials SET status = 'revoked'").run();
    });
  }

  hasPassword(): boolean {
    const row = this.store.database
      .prepare("SELECT 1 AS present FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { present: number } | undefined;
    return row !== undefined;
  }

  /** Snapshot for the session-issuing transaction; never expose it on the wire. */
  passwordDigest(): string | undefined {
    const row = this.store.database.prepare("SELECT password_hash FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { password_hash: string } | undefined;
    return row?.password_hash;
  }

  verifyPassword(password: string): boolean {
    const row = this.store.database
      .prepare("SELECT password_hash FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { password_hash: string } | undefined;
    if (row === undefined) return false;
    return verifyPassword(password, String(row.password_hash));
  }

  async verifyPasswordAsync(password: string): Promise<boolean> {
    const read = () => this.store.database.prepare("SELECT password_hash FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { password_hash: string } | undefined;
    const digest = read()?.password_hash;
    if (digest === undefined || !await verifyPasswordAsync(password, digest)) return false;
    return read()?.password_hash === digest;
  }
}
