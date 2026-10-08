import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Contract section 4 core schema digest.
 *
 * A domain-separated, name-sorted listing of each named schema document's raw
 * byte digest. Hashing the checked-in bytes keeps the value reproducible in
 * every language that can read the files, which is what lets the phone and the
 * Gateway compare the same number instead of a placeholder neither side can
 * derive.
 */
export const CORE_SCHEMA_HASH_DOMAIN = "open-android-intelligence/v2/core-schema-hash";

export const CORE_SCHEMA_FILE_NAMES = [
  "attachment.schema.json",
  "conversation.schema.json",
  "device-request.schema.json",
  "envelope.schema.json",
  "event.schema.json",
  "negotiate.schema.json",
  "session.schema.json",
] as const;

const defaultSchemaDirectory = (): string =>
  join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");

const sha256Hex = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const coreSchemaHash = (
  schemaDirectory: string = defaultSchemaDirectory(),
): string => {
  const lines = [CORE_SCHEMA_HASH_DOMAIN];
  for (const name of CORE_SCHEMA_FILE_NAMES) {
    lines.push(`${name}\tsha256:${sha256Hex(readFileSync(join(schemaDirectory, name)))}`);
  }
  return `sha256:${sha256Hex(Buffer.from(`${lines.join("\n")}\n`, "utf8"))}`;
};
