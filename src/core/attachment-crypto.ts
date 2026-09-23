import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, createReadStream, fstatSync, fsyncSync, openSync, readSync, writeSync, type ReadStream } from "node:fs";

const MAGIC = Buffer.from("OAIEAV1\n", "ascii");
const FOOTER_MAGIC = Buffer.from("OAIEND1\n", "ascii");
const HEADER_BYTES = 20;
const TAG_BYTES = 16;
const FOOTER_HEADER_BYTES = 64;
export const ENCRYPTED_ATTACHMENT_CHUNK_BYTES = 64 * 1024;

const writeAll = (fd: number, bytes: Uint8Array): void => {
  let offset = 0;
  while (offset < bytes.byteLength) {
    let written: number;
    try {
      written = writeSync(fd, bytes, offset, bytes.byteLength - offset);
    } catch (error) {
      throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
    }
    if (written <= 0) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    offset += written;
  }
};

const keyFor = (masterKey: Uint8Array | undefined, accountId: string, attachmentId: string): Buffer => {
  if (masterKey === undefined || masterKey.byteLength !== 32) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
  return Buffer.from(hkdfSync(
    "sha256",
    masterKey,
    Buffer.from(accountId, "utf8"),
    Buffer.from(`open-android-intelligence/attachment/v1/${attachmentId}`, "utf8"),
    32,
  ));
};

const aadFor = (accountId: string, attachmentId: string, index: number, length: number): Buffer =>
  Buffer.from(`OAIEAV1\u0000${accountId}\u0000${attachmentId}\u0000${index}\u0000${length}`, "utf8");

const footerAadFor = (
  accountId: string,
  attachmentId: string,
  chunkCount: number,
  totalBytes: number,
  sha256: string,
): Buffer => Buffer.from(
  `OAIEAV1\u0000${accountId}\u0000${attachmentId}\u0000footer\u0000${chunkCount}\u0000${totalBytes}\u0000${sha256}`,
  "utf8",
);

export type StreamIntegrity = Readonly<{ sizeBytes: number; sha256: string }>;

/** Encrypts an untrusted byte stream using independent bounded AES-GCM records. */
export const encryptAttachmentStream = async (
  masterKey: Uint8Array | undefined,
  accountId: string,
  attachmentId: string,
  destination: string,
  source: AsyncIterable<Uint8Array>,
): Promise<StreamIntegrity> => {
  const key = keyFor(masterKey, accountId, attachmentId);
  let fd: number;
  try {
    fd = openSync(destination, "wx", 0o600);
  } catch (error) {
    key.fill(0);
    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
  }
  let sizeBytes = 0;
  let index = 0;
  let carry = Buffer.alloc(0);
  const digest = createHash("sha256");
  try {
    writeAll(fd, MAGIC);
    const writeRecord = (plain: Buffer): void => {
      if (plain.byteLength === 0 || plain.byteLength > ENCRYPTED_ATTACHMENT_CHUNK_BYTES) {
        throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      }
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aadFor(accountId, attachmentId, index, plain.byteLength));
      const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
      const recordHeader = Buffer.alloc(HEADER_BYTES);
      recordHeader.writeUInt32BE(index, 0);
      recordHeader.writeUInt32BE(plain.byteLength, 4);
      nonce.copy(recordHeader, 8);
      writeAll(fd, recordHeader);
      writeAll(fd, encrypted);
      writeAll(fd, cipher.getAuthTag());
      index += 1;
    };

    for await (const value of source) {
      if (!(value instanceof Uint8Array)) throw new Error("REQUEST_BODY_INVALID");
      if (value.byteLength === 0) continue;
      sizeBytes += value.byteLength;
      if (!Number.isSafeInteger(sizeBytes)) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
      digest.update(value);
      let offset = 0;
      if (carry.byteLength > 0) {
        const count = Math.min(ENCRYPTED_ATTACHMENT_CHUNK_BYTES - carry.byteLength, value.byteLength);
        carry = Buffer.concat([carry, Buffer.from(value.subarray(0, count))]);
        offset += count;
        if (carry.byteLength === ENCRYPTED_ATTACHMENT_CHUNK_BYTES) {
          writeRecord(carry);
          carry = Buffer.alloc(0);
        }
      }
      while (offset + ENCRYPTED_ATTACHMENT_CHUNK_BYTES <= value.byteLength) {
        writeRecord(Buffer.from(value.subarray(offset, offset + ENCRYPTED_ATTACHMENT_CHUNK_BYTES)));
        offset += ENCRYPTED_ATTACHMENT_CHUNK_BYTES;
      }
      if (offset < value.byteLength) carry = Buffer.from(value.subarray(offset));
    }
    if (carry.byteLength > 0) writeRecord(carry);
    const sha256 = digest.digest("hex");
    const footerNonce = randomBytes(12);
    const footerCipher = createCipheriv("aes-256-gcm", key, footerNonce);
    footerCipher.setAAD(footerAadFor(accountId, attachmentId, index, sizeBytes, sha256));
    footerCipher.final();
    const footer = Buffer.alloc(FOOTER_HEADER_BYTES + TAG_BYTES);
    FOOTER_MAGIC.copy(footer, 0);
    footer.writeUInt32BE(index, 8);
    footer.writeBigUInt64BE(BigInt(sizeBytes), 12);
    Buffer.from(sha256, "hex").copy(footer, 20);
    footerNonce.copy(footer, 52);
    footerCipher.getAuthTag().copy(footer, FOOTER_HEADER_BYTES);
    writeAll(fd, footer);
    try { fsyncSync(fd); } catch (error) { throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error }); }
    return Object.freeze({ sizeBytes, sha256 });
  } catch (error) {
    if (error instanceof Error && ["REQUEST_BODY_INVALID", "ATTACHMENT_STORAGE_UNAVAILABLE"].includes(error.message)) throw error;
    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
  } finally {
    try { closeSync(fd); } catch { /* fsync already established durability before close */ }
    key.fill(0);
  }
};

/** Decrypts one verified format stream while keeping memory bounded to a chunk. */
export async function* decryptAttachmentStream(
  masterKey: Uint8Array | undefined,
  accountId: string,
  attachmentId: string,
  sourcePath: string,
): AsyncGenerator<Buffer> {
  const key = keyFor(masterKey, accountId, attachmentId);
  const source = createReadStream(sourcePath, { highWaterMark: ENCRYPTED_ATTACHMENT_CHUNK_BYTES }) as ReadStream;
  let pending = Buffer.alloc(0);
  let headerRead = false;
  let footerRead = false;
  let expectedIndex = 0;
  let actualBytes = 0;
  const actualDigest = createHash("sha256");
  try {
    for await (const rawChunk of source) {
      const chunk = Buffer.from(rawChunk as Uint8Array);
      if (footerRead && chunk.byteLength > 0) throw new Error("ATTACHMENT_READ_FAILED");
      pending = pending.byteLength === 0 ? chunk : Buffer.concat([pending, chunk]);
      if (!headerRead) {
        if (pending.byteLength < MAGIC.byteLength) continue;
        if (!pending.subarray(0, MAGIC.byteLength).equals(MAGIC)) throw new Error("ATTACHMENT_READ_FAILED");
        pending = pending.subarray(MAGIC.byteLength);
        headerRead = true;
      }
      while (pending.byteLength >= HEADER_BYTES) {
        if (pending.byteLength >= FOOTER_MAGIC.byteLength && pending.subarray(0, FOOTER_MAGIC.byteLength).equals(FOOTER_MAGIC)) {
          const footerBytes = FOOTER_HEADER_BYTES + TAG_BYTES;
          if (pending.byteLength < footerBytes) break;
          if (pending.byteLength !== footerBytes) throw new Error("ATTACHMENT_READ_FAILED");
          const chunkCount = pending.readUInt32BE(8);
          const totalBytesBig = pending.readBigUInt64BE(12);
          if (totalBytesBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ATTACHMENT_READ_FAILED");
          const totalBytes = Number(totalBytesBig);
          const expectedDigestBytes = pending.subarray(20, 52);
          const expectedDigest = expectedDigestBytes.toString("hex");
          const footerNonce = pending.subarray(52, 64);
          const footerTag = pending.subarray(FOOTER_HEADER_BYTES, footerBytes);
          const footerDecipher = createDecipheriv("aes-256-gcm", key, footerNonce);
          footerDecipher.setAAD(footerAadFor(accountId, attachmentId, chunkCount, totalBytes, expectedDigest));
          footerDecipher.setAuthTag(footerTag);
          footerDecipher.final();
          if (
            chunkCount !== expectedIndex
            || totalBytes !== actualBytes
            || actualDigest.digest("hex") !== expectedDigest
          ) throw new Error("ATTACHMENT_READ_FAILED");
          pending = pending.subarray(footerBytes);
          footerRead = true;
          break;
        }
        const index = pending.readUInt32BE(0);
        const length = pending.readUInt32BE(4);
        if (index !== expectedIndex || length < 1 || length > ENCRYPTED_ATTACHMENT_CHUNK_BYTES) {
          throw new Error("ATTACHMENT_READ_FAILED");
        }
        const recordBytes = HEADER_BYTES + length + TAG_BYTES;
        if (pending.byteLength < recordBytes) break;
        const nonce = pending.subarray(8, 20);
        const ciphertext = pending.subarray(HEADER_BYTES, HEADER_BYTES + length);
        const tag = pending.subarray(HEADER_BYTES + length, recordBytes);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(aadFor(accountId, attachmentId, index, length));
        decipher.setAuthTag(tag);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
        actualDigest.update(plaintext);
        actualBytes += plaintext.byteLength;
        pending = pending.subarray(recordBytes);
        expectedIndex += 1;
        yield plaintext;
      }
    }
    if (!headerRead || !footerRead || pending.byteLength !== 0) throw new Error("ATTACHMENT_READ_FAILED");
  } catch (error) {
    if (error instanceof Error && error.message === "ATTACHMENT_READ_FAILED") throw error;
    throw new Error("ATTACHMENT_READ_FAILED", { cause: error });
  } finally {
    key.fill(0);
    source.destroy();
  }
}

const readExact = (fd: number, length: number, position: number): Buffer => {
  const output = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const count = readSync(fd, output, read, length - read, position + read);
    if (count <= 0) throw new Error("ATTACHMENT_READ_FAILED");
    read += count;
  }
  return output;
};

/** Synchronous, bounded verification used at the commit boundary before `verified`. */
export const verifyEncryptedAttachmentFile = (
  masterKey: Uint8Array | undefined,
  accountId: string,
  attachmentId: string,
  sourcePath: string,
): StreamIntegrity => {
  const key = keyFor(masterKey, accountId, attachmentId);
  let fd: number | undefined;
  try {
    fd = openSync(sourcePath, "r");
    const fileSize = fstatSync(fd).size;
    if (fileSize < MAGIC.byteLength + FOOTER_HEADER_BYTES + TAG_BYTES) throw new Error("ATTACHMENT_READ_FAILED");
    if (!readExact(fd, MAGIC.byteLength, 0).equals(MAGIC)) throw new Error("ATTACHMENT_READ_FAILED");
    const digest = createHash("sha256");
    let totalBytes = 0;
    let expectedIndex = 0;
    let offset = MAGIC.byteLength;
    while (offset + 8 <= fileSize) {
      const prefix = readExact(fd, 8, offset);
      if (prefix.equals(FOOTER_MAGIC)) {
        const footerBytes = FOOTER_HEADER_BYTES + TAG_BYTES;
        if (offset + footerBytes !== fileSize) throw new Error("ATTACHMENT_READ_FAILED");
        const footer = readExact(fd, footerBytes, offset);
        const chunkCount = footer.readUInt32BE(8);
        const actualBytesBig = footer.readBigUInt64BE(12);
        if (actualBytesBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ATTACHMENT_READ_FAILED");
        const footerBytesTotal = Number(actualBytesBig);
        const expectedDigestBytes = footer.subarray(20, 52);
        const expectedDigest = expectedDigestBytes.toString("hex");
        const nonce = footer.subarray(52, 64);
        const tag = footer.subarray(FOOTER_HEADER_BYTES, footerBytes);
        const decipher = createDecipheriv("aes-256-gcm", key, nonce);
        decipher.setAAD(footerAadFor(accountId, attachmentId, chunkCount, footerBytesTotal, expectedDigest));
        decipher.setAuthTag(tag);
        decipher.final();
        const actualDigest = digest.digest("hex");
        if (chunkCount !== expectedIndex || footerBytesTotal !== totalBytes || expectedDigest !== actualDigest) {
          throw new Error("ATTACHMENT_DIGEST_MISMATCH");
        }
        return Object.freeze({ sizeBytes: totalBytes, sha256: actualDigest });
      }
      const header = readExact(fd, HEADER_BYTES, offset);
      const index = header.readUInt32BE(0);
      const length = header.readUInt32BE(4);
      if (index !== expectedIndex || length < 1 || length > ENCRYPTED_ATTACHMENT_CHUNK_BYTES) {
        throw new Error("ATTACHMENT_READ_FAILED");
      }
      const recordBytes = HEADER_BYTES + length + TAG_BYTES;
      if (offset + recordBytes > fileSize) throw new Error("ATTACHMENT_READ_FAILED");
      const nonce = header.subarray(8, 20);
      const ciphertext = readExact(fd, length, offset + HEADER_BYTES);
      const tag = readExact(fd, TAG_BYTES, offset + HEADER_BYTES + length);
      const decipher = createDecipheriv("aes-256-gcm", key, nonce);
      decipher.setAAD(aadFor(accountId, attachmentId, index, length));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      digest.update(plaintext);
      totalBytes += plaintext.byteLength;
      if (!Number.isSafeInteger(totalBytes)) throw new Error("ATTACHMENT_READ_FAILED");
      expectedIndex += 1;
      offset += recordBytes;
    }
    throw new Error("ATTACHMENT_READ_FAILED");
  } catch (error) {
    if (error instanceof Error && ["ATTACHMENT_READ_FAILED", "ATTACHMENT_DIGEST_MISMATCH"].includes(error.message)) throw error;
    throw new Error("ATTACHMENT_READ_FAILED", { cause: error });
  } finally {
    if (fd !== undefined) closeSync(fd);
    key.fill(0);
  }
};

export const fsyncAttachmentDirectory = (directory: string): void => {
  let fd: number | undefined;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch (error) {
    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* directory entry was already synchronized */ }
    }
  }
};
