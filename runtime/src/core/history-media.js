import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import { realpathSync, statSync, fstatSync, readSync, openSync, closeSync, constants } from "node:fs";
import { basename, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
const sha = (s) => createHash("sha256").update(s).digest("hex");
export class HistoryMedia {
    store;
    accountId;
    constructor(store, accountId) {
        this.store = store;
        this.accountId = accountId;
    }
    put(key, value) { this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key, this.store.sealJson(value, key)); }
    get(key) { const row = this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key); return row ? this.store.openJson(row.value, key) : undefined; }
    register(conversationId, messageId, path, mediaType = "application/octet-stream", extraRoots = []) {
        if (path.startsWith("file://"))
            path = fileURLToPath(path);
        const file = realpathSync(path);
        const roots = [resolve(process.env.OPENCLAW_STATE_DIR ?? resolve(homedir(), ".openclaw"), "media"), ...extraRoots];
        if (!roots.some(root => { try {
            const rel = relative(realpathSync(root), file);
            return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel);
        }
        catch {
            return false;
        } }))
            throw new Error("ATTACHMENT_NOT_FOUND");
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > 25 * 1024 * 1024)
            throw new Error("ATTACHMENT_TOO_LARGE");
        const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        let content;
        try {
            content = readBounded(fd);
        }
        finally {
            closeSync(fd);
        }
        const digest = `sha256:${sha(content)}`;
        const attachmentId = `media_${sha(JSON.stringify([this.accountId, conversationId, messageId, file, digest])).slice(0, 48)}`;
        const record = { attachmentId, conversationId, messageId, path: file, filename: basename(file), mediaType, sizeBytes: stat.size, sha256: digest };
        this.put(`history-media:${attachmentId}`, record);
        const { path: _, conversationId: __, messageId: ___, ...metadata } = record;
        return { type: "attachment", ...metadata };
    }
    record(conversationId, id) { const row = this.get(`history-media:${id}`); if (!row || row.conversationId !== conversationId)
        throw new Error("ATTACHMENT_NOT_FOUND"); return row; }
    metadata(conversationId, id) { const row = this.record(conversationId, id); let available = false; try {
        const st = statSync(String(row.path));
        available = st.isFile() && st.size === row.sizeBytes;
    }
    catch { } const { path: _, ...meta } = row; return { ...meta, remoteAvailable: available, status: available ? "AVAILABLE" : "REMOTE_UNAVAILABLE", estimatedLocalBytes: Number(row.sizeBytes) + 512 }; }
    grant(conversationId, id, context, now = new Date()) { const metadata = this.metadata(conversationId, id); if (!metadata.remoteAvailable)
        throw new Error("ATTACHMENT_NOT_FOUND"); const token = randomBytes(32).toString("base64url"); const expiresAt = new Date(now.getTime() + 120_000).toISOString(); this.put(`history-media-grant:${sha(token)}`, { conversationId, attachmentId: id, deviceId: context.deviceId, pairingGeneration: context.pairingGeneration, grantRevision: context.grantRevision, expiresAt }); return { grantId: token, expiresAt, metadata }; }
    content(conversationId, id, token, context, now = new Date()) {
        return this.store.transaction(() => {
            const key = `history-media-grant:${sha(token)}`;
            const saved = this.get(key);
            if (!saved || Date.parse(String(saved.expiresAt)) <= now.getTime() || saved.conversationId !== conversationId || saved.attachmentId !== id || saved.deviceId !== context.deviceId || saved.pairingGeneration !== context.pairingGeneration || saved.grantRevision !== context.grantRevision)
                throw new Error("AUTHENTICATION_FAILED");
            const row = this.record(conversationId, id);
            const fd = openSync(String(row.path), constants.O_RDONLY | constants.O_NOFOLLOW);
            let body;
            try {
                body = readBounded(fd);
            }
            finally {
                closeSync(fd);
            }
            if (body.length !== row.sizeBytes || `sha256:${sha(body)}` !== row.sha256)
                throw new Error("ATTACHMENT_NOT_FOUND");
            this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(key);
            return { body, mediaType: String(row.mediaType) };
        });
    }
}
function readBounded(fd) {
    const size = fstatSync(fd).size;
    if (size > 25 * 1024 * 1024 || !fstatSync(fd).isFile())
        throw new Error("ATTACHMENT_TOO_LARGE");
    const body = Buffer.alloc(size + 1);
    let offset = 0;
    while (offset < body.length) {
        const count = readSync(fd, body, offset, body.length - offset, null);
        if (count === 0)
            break;
        offset += count;
    }
    if (offset !== size)
        throw new Error("ATTACHMENT_NOT_FOUND");
    return body.subarray(0, size);
}
