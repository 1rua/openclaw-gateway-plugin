import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Account password digests for the OpenClaw Gateway.
 *
 * Contract §5.2 keeps the password out of Android entirely: it is presented once
 * over verified TLS and verified here. Only a digest is stored, so the Gateway
 * can never read a password back, and an account that was never given one cannot
 * be logged into at all.
 */
export const ALGORITHM = "scrypt";
// Interactive-login cost: ~16 MiB of memory, one pass, well under a second.
export const COST_N = 2 ** 14;
export const BLOCK_R = 8;
export const PARALLEL_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

// scrypt hashes at most 1024 bytes of input (RFC 7914).
const MAX_PASSWORD_BYTES = 1024;

const encode = (value: Uint8Array): string => Buffer.from(value).toString("base64url");
const decode = (value: string): Buffer => Buffer.from(value, "base64url");

const passwordBytes = (password: string): Buffer => {
  if (typeof password !== "string" || password.length === 0) {
    throw new Error("PASSWORD_REQUIRED");
  }
  const encoded = Buffer.from(password, "utf8");
  if (encoded.byteLength > MAX_PASSWORD_BYTES) throw new Error("SCHEMA_INVALID");
  return encoded;
};

export const hashPassword = (
  password: string,
  cost: number = COST_N,
  block: number = BLOCK_R,
  parallel: number = PARALLEL_P,
): string => {
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(passwordBytes(password), salt, KEY_BYTES, {
    N: cost,
    r: block,
    p: parallel,
    maxmem: 132 * cost * block,
  });
  return [ALGORITHM, String(cost), String(block), String(parallel), encode(salt), encode(key)].join("$");
};

/**
 * Constant-time verification of a stored digest.
 *
 * A malformed stored value, an unknown algorithm or a non-string input is a
 * failed verification rather than an exception: the caller is an authentication
 * seam that must fail closed.
 */
export const verifyPassword = (password: string, encoded: string): boolean => {
  if (typeof encoded !== "string" || encoded.length === 0) return false;
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== ALGORITHM) return false;
  const cost = Number(parts[1]);
  const block = Number(parts[2]);
  const parallel = Number(parts[3]);
  if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(block) || !Number.isSafeInteger(parallel)) return false;
  if (cost < 2 || block < 1 || parallel < 1) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = decode(parts[4]!);
    expected = decode(parts[5]!);
  } catch {
    return false;
  }
  if (salt.byteLength === 0 || expected.byteLength !== KEY_BYTES) return false;
  let candidate: Buffer;
  try {
    candidate = scryptSync(passwordBytes(password), salt, KEY_BYTES, {
      N: cost,
      r: block,
      p: parallel,
      maxmem: 132 * cost * block,
    });
  } catch {
    return false;
  }
  return candidate.byteLength === expected.byteLength && timingSafeEqual(candidate, expected);
};
