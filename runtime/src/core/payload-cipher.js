import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
export class AccountPayloadCipher {
    accountId;
    key;
    closed = false;
    constructor(masterKey, accountId) {
        this.accountId = accountId;
        if (masterKey !== undefined)
            this.key = Buffer.from(hkdfSync("sha256", masterKey, Buffer.from(accountId), Buffer.from("open-android-intelligence/account-payload/v1"), 32));
    }
    get available() { return this.key !== undefined && !this.closed; }
    seal(value, purpose) {
        if (!this.available)
            throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        const nonce = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
        cipher.setAAD(Buffer.from(JSON.stringify([this.accountId, purpose])));
        const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
        return "aead-v1:" + Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
    }
    open(value, purpose) {
        if (!this.available || !value.startsWith("aead-v1:"))
            throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        try {
            const bytes = Buffer.from(value.slice(8), "base64url");
            if (bytes.byteLength < 28 || bytes.toString("base64url") !== value.slice(8))
                throw new Error("invalid ciphertext");
            const cipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
            cipher.setAAD(Buffer.from(JSON.stringify([this.accountId, purpose])));
            cipher.setAuthTag(bytes.subarray(12, 28));
            return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString("utf8");
        }
        catch {
            throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
        }
    }
    close() { this.closed = true; this.key?.fill(0); }
}
