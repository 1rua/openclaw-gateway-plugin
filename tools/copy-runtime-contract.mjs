import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, renameSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { coreSchemaHash } from "../runtime/gateway-contract/src/core-schema-hash.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const source = join(root, "gateway-contract");
const target = join(root, "runtime", "gateway-contract");
const staging = join(root, ".contract-staging");
mkdirSync(staging, { recursive: true });
const backup = mkdtempSync(join(staging, "runtime-schemas-"));
const rawDirectories = ["schemas", "vectors"];
const preparedDirectories = [];

// tsc 会重排 JSON 空白；协议摘要必须继续使用发布的原始字节。
try {
  for (const name of rawDirectories) {
    const directory = join(target, name);
    if (existsSync(directory)) renameSync(directory, join(backup, name));
    preparedDirectories.push(name);
  }
  for (const name of rawDirectories) {
    cpSync(join(source, name), join(target, name), { recursive: true });
  }
  mkdirSync(target, { recursive: true });
  copyFileSync(join(source, "core-dispatched-schemas.json"), join(target, "core-dispatched-schemas.json"));
} catch (error) {
  // 失败的新产物和旧产物均保留，不执行永久删除。
  for (const name of preparedDirectories) {
    const directory = join(target, name);
    if (existsSync(directory)) renameSync(directory, join(backup, `failed-${name}`));
    if (existsSync(join(backup, name))) renameSync(join(backup, name), directory);
  }
  throw error;
}

const sourceHash = coreSchemaHash(join(source, "schemas"));
const runtimeHash = coreSchemaHash();
if (sourceHash !== runtimeHash) throw new Error("RUNTIME_SCHEMA_HASH_MISMATCH");
console.log(`运行产物与发布契约的原始字节摘要一致：${runtimeHash}`);
