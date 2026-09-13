import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";

const wireIdPattern = /^[A-Za-z0-9._~-]{1,128}$/;

export type AccountPaths = Readonly<{
  root: string;
  database: string;
  attachments: string;
  audit: string;
}>;

export const assertOpaqueId = (accountId: string): void => {
  if (!wireIdPattern.test(accountId)) throw new Error("SCHEMA_INVALID");
};

export const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

export const resolveWithin = (root: string, child: string): string => {
  const resolvedRoot = resolve(root);
  const resolvedChild = resolve(resolvedRoot, child);
  const pathToChild = relative(resolvedRoot, resolvedChild);
  if (
    pathToChild.length === 0 ||
    pathToChild.startsWith("..") ||
    pathToChild.includes(`..${sep}`) ||
    resolve(pathToChild) === pathToChild
  ) {
    throw new Error("SCHEMA_INVALID");
  }
  return resolvedChild;
};

/** Explicit override for hosts that keep Gateway data outside the host data directory. */
export const DEFAULT_ROOT_ENVIRONMENT_VARIABLE = "OPEN_ANDROID_INTELLIGENCE_GATEWAY_ROOT";

/**
 * The account root when the host names no data directory.
 *
 * Resolution is explicit: the configured root, else a loud failure. The current
 * working directory is never used — a data root that followed the shell would
 * silently create a second, empty Gateway next to whatever directory happened to
 * be current, and an operator would see an account that "disappeared".
 */
export const defaultOpenClawGatewayRoot = (): string => {
  const configured = process.env[DEFAULT_ROOT_ENVIRONMENT_VARIABLE];
  if (configured !== undefined && configured.trim().length > 0) {
    return resolve(configured.trim(), "accounts");
  }
  throw new Error("STORAGE_ROOT_REQUIRED");
};

export const accountPaths = (root: string, accountId: string): AccountPaths => {
  assertOpaqueId(accountId);
  const accountRoot = resolveWithin(root, sha256Hex(accountId));
  return Object.freeze({
    root: accountRoot,
    database: join(accountRoot, "gateway.sqlite"),
    attachments: join(accountRoot, "attachments"),
    audit: join(accountRoot, "audit"),
  });
};

export const ensureAccountDirectories = (paths: AccountPaths): void => {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  mkdirSync(paths.attachments, { recursive: true, mode: 0o700 });
  mkdirSync(paths.audit, { recursive: true, mode: 0o700 });
};
