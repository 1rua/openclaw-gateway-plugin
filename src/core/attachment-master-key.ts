import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

export const ATTACHMENT_MASTER_KEY_FILE_ENV = "OPEN_ANDROID_INTELLIGENCE_GATEWAY_MASTER_KEY_FILE";

export type AttachmentMasterKey = Readonly<{
  bytes?: Buffer;
  reference: string;
}>;

/** Loads an operator-provisioned 32-byte key file with owner-only permissions. */
export const loadAttachmentMasterKey = (injected?: Uint8Array): AttachmentMasterKey => {
  if (injected !== undefined) {
    if (injected.byteLength !== 32) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    const bytes = Buffer.from(injected);
    return Object.freeze({ bytes, reference: `sha256:${createHash("sha256").update(bytes).digest("hex")}` });
  }
  const path = process.env[ATTACHMENT_MASTER_KEY_FILE_ENV];
  if (path === undefined || path.trim().length === 0) return Object.freeze({ reference: "unconfigured" });
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
      throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    }
    const material = Buffer.alloc(33);
    const length = readSync(descriptor, material, 0, material.byteLength, 0);
    if (length !== 32) throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE");
    const bytes = material.subarray(0, 32);
    return Object.freeze({
      bytes,
      reference: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    });
  } catch (error) {
    if (error instanceof Error && error.message === "ATTACHMENT_STORAGE_UNAVAILABLE") throw error;
    throw new Error("ATTACHMENT_STORAGE_UNAVAILABLE", { cause: error });
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
};
