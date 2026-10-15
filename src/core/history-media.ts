import { fileURLToPath } from "node:url";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, writeSync, type Stats } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { validateHeaderValue } from "node:http";
import type { GatewayAccountStore } from "./account-store.js";
import type { VerifiedRequestContext } from "./gateway-core.js";

export type HistoryMediaFormat = "stream-v1" | undefined;
const BLOCK_BYTES = 64 * 1024;
const LEGACY_MAX_BYTES = 25 * 1024 * 1024;
const sha = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");
const hostState = (): string => resolve(process.env.OPENCLAW_STATE_DIR ?? join(homedir(), ".openclaw"));
const within = (root: string, file: string): boolean => {
  const path = relative(root, file);
  return path !== "" && path !== ".." && !path.startsWith("../") && !isAbsolute(path);
};
const stable = (before: Stats, after: Stats): boolean => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs && before.ctimeMs === after.ctimeMs;
const assertRegular = (stat: Stats): void => {
  if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 0) throw new Error("ATTACHMENT_NOT_FOUND");
};
const assertMime = (value: string): void => {
  if (value.length === 0 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error("SCHEMA_INVALID");
  try { validateHeaderValue("content-type", value); } catch { throw new Error("SCHEMA_INVALID"); }
};
const originalInfo = (path: string): Readonly<{ sizeBytes: number; sha256: string }> => {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd); assertRegular(before);
    const hash = createHash("sha256"); const block = Buffer.alloc(BLOCK_BYTES); let length = 0;
    for (;;) {
      const count = readSync(fd, block, 0, block.length, null);
      if (count === 0) break;
      hash.update(block.subarray(0, count)); length += count;
    }
    if (length !== before.size || !stable(before, fstatSync(fd)) || !stable(before, lstatSync(path))) throw new Error("ATTACHMENT_NOT_FOUND");
    return { sizeBytes: length, sha256: `sha256:${hash.digest("hex")}` };
  } finally { closeSync(fd); }
};
const retire = (path: string): void => {
  if (!existsSync(path)) return;
  const trash = join(tmpdir(), "open-android-intelligence-trash");
  mkdirSync(trash, { recursive: true, mode: 0o700 });
  renameSync(path, join(trash, `history-media-${randomUUID()}`));
};

export class HistoryMediaStream {
  readonly headers: Readonly<Record<string, string>>;
  private fd: number;
  private readonly before: Stats;
  constructor(private readonly row: Record<string, unknown>, private readonly authorize: () => boolean | Promise<boolean>) {
    assertMime(String(row.mediaType));
    this.fd = openSync(String(row.path), constants.O_RDONLY | constants.O_NOFOLLOW);
    this.before = fstatSync(this.fd);
    try {
      assertRegular(this.before);
      if (this.before.size !== row.sizeBytes || !/^sha256:[0-9a-f]{64}$/u.test(String(row.sha256))) throw new Error("ATTACHMENT_NOT_FOUND");
      this.headers = Object.freeze({
        "content-type": String(row.mediaType), "content-length": String(row.sizeBytes),
        digest: `sha-256=${Buffer.from(String(row.sha256).slice(7), "hex").toString("base64")}`,
        "x-open-android-intelligence-media-format": "stream-v1", "cache-control": "private, no-store",
      });
    } catch (error) { this.close(); throw error; }
  }
  close(): void { if (this.fd >= 0) { closeSync(this.fd); this.fd = -1; } }
  async *chunks(): AsyncGenerator<Uint8Array> {
    const hash = createHash("sha256"); let length = 0;
    try {
      for (;;) {
        if (this.fd < 0 || !await this.authorize()) throw new Error("SESSION_REVOKED");
        if (!stable(this.before, fstatSync(this.fd)) || !stable(this.before, lstatSync(String(this.row.path)))) throw new Error("ATTACHMENT_NOT_FOUND");
        const block = Buffer.alloc(BLOCK_BYTES);
        const count = readSync(this.fd, block, 0, block.length, null);
        if (count === 0) break;
        length += count; hash.update(block.subarray(0, count));
        if (length > Number(this.row.sizeBytes)) throw new Error("ATTACHMENT_NOT_FOUND");
        yield block.subarray(0, count);
      }
      if (length !== this.row.sizeBytes || `sha256:${hash.digest("hex")}` !== this.row.sha256) throw new Error("ATTACHMENT_NOT_FOUND");
    } finally { this.close(); }
  }
}

export class HistoryMedia {
  constructor(private readonly store: GatewayAccountStore, private readonly accountId: string) {}
  private put(key: string, value: Record<string, unknown>): void {
    this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key, this.store.sealJson(value, key));
  }
  private get(key: string): Record<string, unknown> | undefined {
    const row = this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as { value: string } | undefined;
    return row ? this.store.openJson(row.value, key) as Record<string, unknown> : undefined;
  }
  private owner(): string { return sha(resolve(this.store.storageOwner)); }
  private accountRoot(): string { return join(hostState(), "history-media", "open-android-intelligence", "owners", this.owner(), "accounts", sha(this.accountId)); }
  private legacyAccountRoot(): string { return join(hostState(), "media", "open-android-intelligence-history", sha(this.accountId)); }
  private part(row: Record<string, unknown>, includeDigest = true): Record<string, unknown> {
    return { type: "attachment", attachmentId: row.attachmentId, filename: row.filename, mediaType: row.mediaType, sizeBytes: row.sizeBytes, ...(includeDigest ? { sha256: row.sha256 } : {}) };
  }
  private matches(row: Record<string, unknown>): boolean {
    try {
      if (row.deleted || row.storageOwner !== undefined && row.storageOwner !== this.owner()) return false;
      if (row.storageOwner !== undefined && !within(realpathSync(this.accountRoot()), realpathSync(String(row.path)))) return false;
      const info = originalInfo(String(row.path));
      return info.sizeBytes === row.sizeBytes && info.sha256 === row.sha256;
    } catch { return false; }
  }
  private adopt(row: Record<string, unknown>, source: string): Record<string, unknown> {
    const root = join(this.accountRoot(), sha(String(row.conversationId)));
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = join(root, `${sha(String(row.attachmentId))}-${randomUUID()}.bin`);
    const pending = target + ".pending";
    let input: number | undefined; let output: number | undefined;
    try {
      input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = fstatSync(input); assertRegular(before);
      output = openSync(pending, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      const block = Buffer.alloc(BLOCK_BYTES); const hash = createHash("sha256"); let length = 0;
      for (;;) {
        const count = readSync(input, block, 0, block.length, null); if (count === 0) break;
        hash.update(block.subarray(0, count)); length += count;
        let offset = 0;
        while (offset < count) offset += writeSync(output, block, offset, count - offset);
      }
      if (length !== row.sizeBytes || `sha256:${hash.digest("hex")}` !== row.sha256 || !stable(before, fstatSync(input)) || !stable(before, lstatSync(source))) throw new Error("ATTACHMENT_NOT_FOUND");
      fsyncSync(output); closeSync(output); output = undefined; closeSync(input); input = undefined;
      renameSync(pending, target);
      return { ...row, path: target, sourcePath: row.sourcePath ?? source, storageOwner: this.owner() };
    } catch (error) {
      if (input !== undefined) closeSync(input);
      if (output !== undefined) closeSync(output);
      retire(pending); throw error;
    }
  }
  private record(conversationId: string, id: string): Record<string, unknown> {
    let row = this.get(`history-media:${id}`);
    if (!row || row.conversationId !== conversationId || row.storageOwner !== undefined && row.storageOwner !== this.owner()) throw new Error("ATTACHMENT_NOT_FOUND");
    if (row.storageOwner === undefined && !row.deleted && this.matches(row)) {
      row = this.adopt({ ...row, origin: row.origin ?? "legacy-reference" }, String(row.path)); this.put(`history-media:${id}`, row);
    }
    return row;
  }
  register(conversationId: string, messageId: string, path: string, mediaType = "application/octet-stream", extraRoots: readonly string[] = []): Record<string, unknown> {
    if (path.startsWith("file://")) path = fileURLToPath(path);
    const sourceKey = `history-media-source:${sha(JSON.stringify([conversationId, messageId, resolve(path)]))}`;
    let file: string;
    try { file = realpathSync(path); }
    catch {
      const previous = this.get(sourceKey);
      if (!previous) throw new Error("ATTACHMENT_NOT_FOUND");
      const row = this.record(conversationId, String(previous.attachmentId));
      if (!this.matches(row)) throw new Error("ATTACHMENT_NOT_FOUND");
      return this.part(row);
    }
    const roots = [join(hostState(), "media"), ...extraRoots];
    if (!roots.some(root => { try { return within(realpathSync(root), file); } catch { return false; } })) throw new Error("ATTACHMENT_NOT_FOUND");
    const info = originalInfo(file);
    const attachmentId = `media_${sha(JSON.stringify([this.accountId, conversationId, messageId, file, info.sha256])).slice(0, 48)}`;
    const existing = this.get(`history-media:${attachmentId}`);
    if (existing?.deleted) throw new Error("ATTACHMENT_NOT_FOUND");
    if (existing && this.matches(existing)) return this.part(existing);
    const row = this.adopt({ attachmentId, conversationId, messageId, path: file, sourcePath: file, filename: basename(file), mediaType, ...info, origin: "agent-output" }, file);
    this.put(`history-media:${attachmentId}`, row); this.put(sourceKey, { attachmentId });
    return this.part(row);
  }
  adoptInbound(conversationId: string, messageId: string, attachments: readonly Readonly<{ attachmentId: string; filename: string; mediaType: string; sizeBytes: number; sha256: string }>[], paths: readonly string[]): void {
    if (paths.length !== attachments.length) throw new Error("ATTACHMENT_NOT_FOUND");
    for (const [index, attachment] of attachments.entries()) {
      const prior = this.get(`history-media:${attachment.attachmentId}`);
      if (prior?.deleted) throw new Error("ATTACHMENT_NOT_FOUND");
      if (prior && prior.conversationId === conversationId && prior.messageId === messageId && this.matches(prior)) continue;
      const row = this.adopt({ ...attachment, conversationId, messageId, origin: "device-upload", sourcePath: paths[index]!, sha256: attachment.sha256.startsWith("sha256:") ? attachment.sha256 : `sha256:${attachment.sha256}` }, paths[index]!);
      this.put(`history-media:${attachment.attachmentId}`, row);
    }
    this.put(`history-media-upload:${conversationId}:${messageId}`, { attachmentIds: attachments.map(item => item.attachmentId) });
  }
  uploadParts(conversationId: string, attachmentIds: readonly string[], messageId?: string): Record<string, unknown>[] {
    const saved = messageId === undefined ? undefined : this.get(`history-media-upload:${conversationId}:${messageId}`);
    const ids = attachmentIds.length > 0 ? attachmentIds : Array.isArray(saved?.attachmentIds) ? saved.attachmentIds.filter((id): id is string => typeof id === "string") : [];
    return ids.flatMap(id => { const row = this.get(`history-media:${id}`); return row && row.conversationId === conversationId && !row.deleted && (row.storageOwner === undefined || row.storageOwner === this.owner()) ? [this.part(row, false)] : []; });
  }
  isActive(conversationId: string, id: string): boolean {
    const row = this.get(`history-media:${id}`);
    return !!row && row.conversationId === conversationId && !row.deleted && row.storageOwner === this.owner();
  }
  markDeleted(conversationId: string, messageId: string): void {
    for (const saved of this.store.database.prepare("SELECT key,value FROM account_metadata WHERE key LIKE 'history-media:%'").all() as Array<{ key: string; value: string }>) {
      const row = this.store.openJson(saved.value, saved.key) as Record<string, unknown>;
      if (row.conversationId === conversationId && row.messageId === messageId && !row.deleted) this.put(saved.key, { ...row, deleted: true });
    }
  }
  retireAccount(): void { retire(this.accountRoot()); retire(this.legacyAccountRoot()); }
  metadata(conversationId: string, id: string, format?: HistoryMediaFormat): Record<string, unknown> {
    const row = this.record(conversationId, id);
    const available = (format === "stream-v1" || Number(row.sizeBytes) <= LEGACY_MAX_BYTES) && this.matches(row);
    return { attachmentId: row.attachmentId, conversationId, messageId: row.messageId, filename: row.filename, mediaType: row.mediaType, sizeBytes: row.sizeBytes, sha256: row.sha256, remoteAvailable: available, status: available ? "AVAILABLE" : "REMOTE_UNAVAILABLE", estimatedLocalBytes: Number(row.sizeBytes) + 512 };
  }
  grant(conversationId: string, id: string, context: VerifiedRequestContext, now = new Date(), format?: HistoryMediaFormat): Record<string, unknown> {
    if (context.accountId !== this.accountId) throw new Error("AUTHENTICATION_FAILED");
    const metadata = this.metadata(conversationId, id, format);
    if (!metadata.remoteAvailable) throw new Error("ATTACHMENT_NOT_FOUND");
    const token = randomBytes(32).toString("base64url"); const expiresAt = new Date(now.getTime() + 120_000).toISOString();
    this.put(`history-media-grant:${sha(token)}`, { conversationId, attachmentId: id, deviceId: context.deviceId, pairingGeneration: context.pairingGeneration, grantRevision: context.grantRevision, expiresAt, format: format ?? null });
    return { grantId: token, expiresAt, metadata };
  }
  private consume(conversationId: string, id: string, token: string, context: VerifiedRequestContext, now: Date, format: HistoryMediaFormat): Record<string, unknown> {
    if (context.accountId !== this.accountId) throw new Error("AUTHENTICATION_FAILED");
    const key = `history-media-grant:${sha(token)}`; const saved = this.get(key);
    if (!saved || Date.parse(String(saved.expiresAt)) <= now.getTime() || saved.conversationId !== conversationId || saved.attachmentId !== id || saved.deviceId !== context.deviceId || saved.pairingGeneration !== context.pairingGeneration || saved.grantRevision !== context.grantRevision || (saved.format ?? null) !== (format ?? null)) throw new Error("AUTHENTICATION_FAILED");
    const row = this.record(conversationId, id);
    if (!this.matches(row)) throw new Error("ATTACHMENT_NOT_FOUND");
    this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(key); return row;
  }
  contentStream(conversationId: string, id: string, token: string, context: VerifiedRequestContext, now = new Date(), authorize: () => boolean | Promise<boolean> = () => true): HistoryMediaStream {
    return this.store.transaction(() => new HistoryMediaStream(this.consume(conversationId, id, token, context, now, "stream-v1"), authorize));
  }
  content(conversationId: string, id: string, token: string, context: VerifiedRequestContext, now = new Date()): Readonly<{ body: Uint8Array; mediaType: string }> {
    return this.store.transaction(() => {
      const row = this.consume(conversationId, id, token, context, now, undefined);
      if (Number(row.sizeBytes) > LEGACY_MAX_BYTES) throw new Error("ATTACHMENT_TOO_LARGE");
      const fd = openSync(String(row.path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = fstatSync(fd); assertRegular(before);
        const body = Buffer.alloc(Number(row.sizeBytes) + 1); let length = 0;
        while (length < body.length) { const count = readSync(fd, body, length, body.length - length, null); if (!count) break; length += count; }
        if (length !== row.sizeBytes || !stable(before, fstatSync(fd)) || `sha256:${sha(body.subarray(0, length))}` !== row.sha256) throw new Error("ATTACHMENT_NOT_FOUND");
        return { body: body.subarray(0, length), mediaType: String(row.mediaType) };
      } finally { closeSync(fd); }
    });
  }
}
