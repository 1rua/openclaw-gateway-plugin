import type { GatewayAccountStore } from "./account-store.js";
import { hashPassword, verifyPassword } from "./credentials.js";

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
    const digest = hashPassword(password);
    this.store.database
      .prepare(`
        INSERT INTO account_credentials(credential_id, password_hash, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(credential_id) DO UPDATE SET
          password_hash = excluded.password_hash, updated_at = excluded.updated_at
      `)
      .run(PASSWORD_CREDENTIAL_ID, digest, now.toISOString());
  }

  hasPassword(): boolean {
    const row = this.store.database
      .prepare("SELECT 1 AS present FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { present: number } | undefined;
    return row !== undefined;
  }

  verifyPassword(password: string): boolean {
    const row = this.store.database
      .prepare("SELECT password_hash FROM account_credentials WHERE credential_id = ?")
      .get(PASSWORD_CREDENTIAL_ID) as { password_hash: string } | undefined;
    if (row === undefined) return false;
    return verifyPassword(password, String(row.password_hash));
  }
}
