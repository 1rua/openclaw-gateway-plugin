import { createHash, randomUUID } from "node:crypto";

import { accountPaths, defaultOpenClawGatewayRoot } from "./account-paths.js";
import { openAccountStore } from "./account-store.js";
import { AuditStore } from "./audit-store.js";

export type RotationReceipt = Readonly<{
  receiptId: string;
  accountId: string;
  previousIdentityRef: string;
  nextIdentityRef: string;
  masterKeyRef: string;
  rotatedAt: string;
}>;

export class IdentityRotationService {
  private readonly storageRoot: string;

  constructor(options: Readonly<{ storageRoot?: string }> = {}) {
    this.storageRoot = options.storageRoot ?? defaultOpenClawGatewayRoot();
  }

  async rotate(request: Readonly<{
    accountId: string;
    previousIdentityRef: string;
    nextIdentityRef: string;
    signedByPrevious: string;
    correlationId: string;
    now?: Date;
  }>): Promise<RotationReceipt> {
    const paths = accountPaths(this.storageRoot, request.accountId);
    const store = openAccountStore(paths);
    const audit = new AuditStore(store);
    try {
      return store.transaction(() => {
        const currentIdentity = (store.database
          .prepare("SELECT value FROM account_metadata WHERE key = 'gateway_identity_ref'")
          .get() as { value: string }).value;
        if (currentIdentity !== request.previousIdentityRef) {
          throw new Error("TLS_IDENTITY_REQUIRED");
        }
        const masterKeyRef = (store.database
          .prepare("SELECT value FROM account_metadata WHERE key = 'master_key_ref'")
          .get() as { value: string }).value;
        const receiptId = `rot_${randomUUID()}`;
        const rotatedAt = (request.now ?? new Date()).toISOString();
        store.database
          .prepare(`
            INSERT INTO identity_rotation_receipts(
              receipt_id, previous_identity_ref, next_identity_ref, proof_hash,
              master_key_ref, rotated_at, correlation_id
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .run(
            receiptId,
            request.previousIdentityRef,
            request.nextIdentityRef,
            createHash("sha256").update(request.signedByPrevious, "utf8").digest("hex"),
            masterKeyRef,
            rotatedAt,
            request.correlationId,
          );
        store.database
          .prepare("UPDATE account_metadata SET value = ? WHERE key = 'gateway_identity_ref'")
          .run(request.nextIdentityRef);
        audit.append({
          eventType: "gateway.identity.rotated",
          actor: { accountId: request.accountId },
          subject: {
            receiptId,
            previousIdentityRef: request.previousIdentityRef,
            nextIdentitySha256: createHash("sha256").update(request.nextIdentityRef, "utf8").digest("hex"),
          },
          correlationId: request.correlationId,
          occurredAt: rotatedAt,
        });
        return Object.freeze({
          receiptId,
          accountId: request.accountId,
          previousIdentityRef: request.previousIdentityRef,
          nextIdentityRef: request.nextIdentityRef,
          masterKeyRef,
          rotatedAt,
        });
      });
    } finally {
      store.close();
    }
  }
}
