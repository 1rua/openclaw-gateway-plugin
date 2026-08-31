import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import canonicalize from "canonicalize";

import {
  createGatewayDispatchedValidator,
  gatewaySubschemaSha256,
  type GatewayDispatchedValidator,
  type GatewayLogicalSubschemaKey,
  type GatewaySubschemaCatalogEntry,
  type TrustedGatewayDispatch,
  type VerifiedSchemaBindingSet,
} from "../../../../gateway-contract/src/dispatched-schema-validator.js";
import {
  canonicalRequestSignatureInput,
  canonicalRequestTarget,
  type SignedRequestInput,
  type SignedRequestMethod,
} from "../../../../gateway-contract/src/request-signature.js";
import {
  validateGatewayValue,
  type GatewaySchemaName,
} from "../../../../gateway-contract/src/schema-registry.js";
import {
  maximumDeviceRequestQueueSeconds,
  nextAttachmentState,
  nextDeviceRequestState,
  type AttachmentEvent,
  type AttachmentState,
  type DeviceRequestEvent,
  type DeviceRequestState,
  type DeviceRequestRisk,
} from "../../../../gateway-contract/src/state-machines.js";

/**
 * OpenClaw-side consumer of the shared Gateway Protocol v2 vectors.
 *
 * This module is the TypeScript counterpart of the Hermes Python
 * `GatewayCore.run_shared_vectors()` seam. Both implementations read the same
 * `gateway-contract/vectors/*.json` documents and the same single dispatched
 * fixture registry, and both project each case into the same normalized result
 * so the cross-host conformance gate can compare result hashes.
 */

export const OPENCLAW_IMPLEMENTATION_ID = "openclaw-typescript";

export const CONFORMANCE_VECTOR_FILE_NAMES = [
  "request-signatures.json",
  "protocol-negotiation.json",
  "auth-sessions.json",
  "attachments.json",
  "sse-events.json",
  "device-requests.json",
  "conversation-ui.json",
] as const;

const FIXTURE_REGISTRY_FILE_NAME = "dispatched-schema-fixtures.json";
const FIXTURE_META_SCHEMA_FILE_NAME = "dispatched-schema-fixtures-1.0.0.schema.json";
const SHARED_BINDING_SET_ID = "gateway-core-fixtures-v1";
const EXPECTED_CATALOG_ENTRY_COUNT = 4;

export type ConformanceVectorOperation =
  | "request.target"
  | "request.signature"
  | "schema.validate"
  | "schema.validate_dispatched"
  | "attachment.transition"
  | "device.transition"
  | "device.maximum_queue_seconds";

export type ConformanceErrorCode =
  | "SCHEMA_INVALID"
  | "NON_CANONICAL_TARGET"
  | "INVALID_STATE_TRANSITION";

export type ConformanceActualResult =
  | Readonly<{
      vectorId: string;
      operation: ConformanceVectorOperation;
      outcome: "value";
      value: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{
      vectorId: string;
      operation: ConformanceVectorOperation;
      outcome: "error";
      code: ConformanceErrorCode;
    }>;

export type ConformanceResult = Readonly<{
  vectorId: string;
  operation: ConformanceVectorOperation;
  implementation: typeof OPENCLAW_IMPLEMENTATION_ID;
  status: "pass" | "fail";
  resultHash: string;
}>;

type VectorExpected =
  | Readonly<{ outcome: "value"; value: Readonly<Record<string, unknown>> }>
  | Readonly<{ outcome: "error"; code: ConformanceErrorCode }>;

type VectorCase = Readonly<{
  id: string;
  operation: ConformanceVectorOperation;
  input: Readonly<Record<string, unknown>>;
  expected: VectorExpected;
}>;

type FixtureCatalogEntry = Readonly<{
  key: Readonly<Record<string, unknown>>;
  schema: object;
}>;

type FixtureBinding = Readonly<{
  key: Readonly<Record<string, unknown>>;
  schemaSha256: string;
}>;

type FixtureRegistryDocument = Readonly<{
  formatVersion: unknown;
  catalogEntries: readonly FixtureCatalogEntry[];
  bindingSets: readonly Readonly<{ id: unknown; bindings: readonly FixtureBinding[] }>[];
}>;

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;
const moduleDirectory = dirname(fileURLToPath(import.meta.url));

const readJson = (path: string): unknown => JSON.parse(readFileSync(path, "utf8"));

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const canonicalJson = (value: unknown): string => {
  const result = canonicalize(value);
  if (result === undefined) throw new Error("JCS_CANONICALIZATION_FAILED");
  return result;
};

const schemaInvalid = (): never => {
  throw new Error("SCHEMA_INVALID");
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asRecord = (value: unknown, label: string): Readonly<Record<string, unknown>> => {
  if (!isRecord(value)) throw new Error(`INVALID_VECTOR_RECORD:${label}`);
  return value;
};

const requireString = (
  record: Readonly<Record<string, unknown>>,
  field: string,
): string => {
  const value = record[field];
  return typeof value === "string" ? value : schemaInvalid();
};

const decodeBodyHex = (value: unknown): Uint8Array => {
  const hex =
    typeof value === "string" && /^(?:[0-9a-f]{2})*$/.test(value) ? value : schemaInvalid();
  return Uint8Array.from(Buffer.from(hex, "hex"));
};

/**
 * Locates the shared contract package without hard-coding an absolute path.
 * The same discovery rule is used by the Hermes Python implementation so both
 * hosts resolve one and the same contract directory.
 */
export const resolveContractRoot = (explicit?: string): string => {
  const candidates: string[] = [];
  if (explicit !== undefined) {
    const given = resolve(explicit);
    candidates.push(given, join(given, "gateway-contract"));
  }
  for (let current = moduleDirectory; ; current = dirname(current)) {
    candidates.push(join(current, "gateway-contract"));
    if (dirname(current) === current) break;
  }
  for (let current = resolve(process.cwd()); ; current = dirname(current)) {
    candidates.push(join(current, "gateway-contract"));
    if (dirname(current) === current) break;
  }
  for (const candidate of candidates) {
    if (
      isFile(join(candidate, "schemas", "envelope.schema.json")) &&
      isFile(join(candidate, "vectors", "vector-set-1.0.0.schema.json"))
    ) {
      return candidate;
    }
  }
  throw new Error("INTERNAL_ERROR:gateway-contract assets unavailable");
};

const logicalKeyOf = (
  key: Readonly<Record<string, unknown>>,
): GatewayLogicalSubschemaKey => {
  const { schemaSha256: _schemaSha256, ...logical } = key;
  return logical as unknown as GatewayLogicalSubschemaKey;
};

type SharedSchemaRegistry = Readonly<{
  entries: readonly GatewaySubschemaCatalogEntry[];
  bindings: readonly FixtureBinding[];
  validator: GatewayDispatchedValidator;
}>;

/**
 * Verifies and reads the one shared dispatched fixture registry. The four
 * canonical Schema digests are recomputed here; no Schema, digest or binding
 * may be inlined or substituted by this host.
 */
const loadSharedSchemaRegistry = (contractRoot: string): SharedSchemaRegistry => {
  const vectorsDirectory = join(contractRoot, "vectors");
  const metaSchema = readJson(join(vectorsDirectory, FIXTURE_META_SCHEMA_FILE_NAME));
  const document = readJson(
    join(vectorsDirectory, FIXTURE_REGISTRY_FILE_NAME),
  ) as FixtureRegistryDocument;

  const metaValidator = addFormats(new Ajv2020({ strict: true })).compile(
    asRecord(metaSchema, FIXTURE_META_SCHEMA_FILE_NAME) as object,
  );
  if (!metaValidator(document)) throw new Error("INVALID_FIXTURE_REGISTRY");

  if (
    document.formatVersion !== "1.0.0" ||
    document.catalogEntries.length !== EXPECTED_CATALOG_ENTRY_COUNT ||
    document.bindingSets.length !== 1 ||
    document.bindingSets[0]?.id !== SHARED_BINDING_SET_ID
  ) {
    throw new Error("INVALID_FIXTURE_REGISTRY");
  }

  const bindings = document.bindingSets[0]!.bindings;
  if (bindings.length !== EXPECTED_CATALOG_ENTRY_COUNT) {
    throw new Error("INVALID_FIXTURE_REGISTRY");
  }

  const entries: GatewaySubschemaCatalogEntry[] = [];
  for (const entry of document.catalogEntries) {
    const canonical = canonicalJson(entry.schema);
    const digest = `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
    const recorded = entry.key["schemaSha256"];
    if (digest !== recorded || gatewaySubschemaSha256(entry.schema) !== digest) {
      throw new Error("INVALID_FIXTURE_REGISTRY");
    }
    const logical = canonicalJson(logicalKeyOf(entry.key));
    const binding = bindings.find(
      (candidate) => canonicalJson(logicalKeyOf(candidate.key)) === logical,
    );
    if (binding === undefined || binding.schemaSha256 !== digest) {
      throw new Error("INVALID_FIXTURE_REGISTRY");
    }
    entries.push({ key: entry.key as GatewaySubschemaCatalogEntry["key"], schema: entry.schema });
  }

  const core: VerifiedSchemaBindingSet["core"][number][] = [];
  const device: VerifiedSchemaBindingSet["device"][number][] = [];
  for (const binding of bindings) {
    const logical = logicalKeyOf(binding.key);
    const digest = binding.schemaSha256;
    if (logical.kind === "device.request") {
      device.push({
        kind: "device.request",
        pluginId: logical.pluginId,
        authorKeyId: logical.authorKeyId,
        capabilityId: logical.capabilityId,
        capabilityVersion: logical.capabilityVersion,
        schemaSha256: digest,
      });
    } else if (logical.kind === "event") {
      core.push({ kind: "event", eventType: logical.eventType, schemaSha256: digest });
    } else if (logical.kind === "response.success") {
      core.push({
        kind: "response.success",
        operation: logical.operation,
        status: logical.status,
        schemaSha256: digest,
      });
    } else {
      core.push({ kind: "response.failure", errorCode: logical.errorCode, schemaSha256: digest });
    }
  }
  const bindingSet: VerifiedSchemaBindingSet = { core, device };

  return {
    entries,
    bindings,
    validator: createGatewayDispatchedValidator(entries, bindingSet),
  };
};

const forbiddenDispatchKeys = ["schemaSha256", "schema", "binding", "resolver", "validator"];

const trustedDispatchOf = (value: unknown): TrustedGatewayDispatch => {
  const dispatch = asRecord(value, "dispatch");
  for (const key of forbiddenDispatchKeys) {
    if (Object.hasOwn(dispatch, key)) throw new Error("INVALID_FIXTURE_BINDING_SET");
  }
  return dispatch as unknown as TrustedGatewayDispatch;
};

const withVectorError = (
  operation: () => Readonly<Record<string, unknown>>,
): Readonly<{ outcome: "value"; value: Readonly<Record<string, unknown>> }> | Readonly<{ outcome: "error"; code: ConformanceErrorCode }> => {
  try {
    return { outcome: "value", value: operation() };
  } catch (cause) {
    const code = cause instanceof Error ? cause.message : "";
    if (
      code !== "SCHEMA_INVALID" &&
      code !== "NON_CANONICAL_TARGET" &&
      code !== "INVALID_STATE_TRANSITION"
    ) {
      throw cause;
    }
    return { outcome: "error", code };
  }
};

const runCase = (
  vectorCase: VectorCase,
  sharedRegistry: SharedSchemaRegistry,
): ConformanceActualResult => {
  const input = vectorCase.input;
  const projected = (() => {
    switch (vectorCase.operation) {
      case "request.target":
        return withVectorError(() => ({
          canonicalTarget: canonicalRequestTarget(requireString(input, "target")),
        }));
      case "request.signature": {
        const signedInput: SignedRequestInput = {
          method: requireString(input, "method") as SignedRequestMethod,
          target: requireString(input, "target"),
          accountId: requireString(input, "accountId"),
          deviceId: requireString(input, "deviceId"),
          sessionId: requireString(input, "sessionId"),
          requestId: requireString(input, "requestId"),
          timestamp: requireString(input, "timestamp"),
          nonce: requireString(input, "nonce"),
          body: decodeBodyHex(input["bodyHex"]),
        };
        return withVectorError(() => ({
          preimageHex: Buffer.from(canonicalRequestSignatureInput(signedInput)).toString("hex"),
        }));
      }
      case "schema.validate": {
        const schemaName = requireString(input, "schemaName") as GatewaySchemaName;
        const result = validateGatewayValue(schemaName, input["value"]);
        return result.ok
          ? ({ outcome: "value", value: { valid: true } } as const)
          : ({ outcome: "error", code: "SCHEMA_INVALID" } as const);
      }
      case "schema.validate_dispatched": {
        if (input["fixtureBindingSetId"] !== SHARED_BINDING_SET_ID) {
          throw new Error("INVALID_FIXTURE_BINDING_SET");
        }
        const result = sharedRegistry.validator.validate(
          trustedDispatchOf(input["dispatch"]),
          input["value"],
        );
        return result.ok
          ? ({ outcome: "value", value: { valid: true } } as const)
          : ({ outcome: "error", code: "SCHEMA_INVALID" } as const);
      }
      case "attachment.transition":
        return withVectorError(() => ({
          nextState: nextAttachmentState(
            requireString(input, "current") as AttachmentState,
            requireString(input, "event") as AttachmentEvent,
          ),
        }));
      case "device.transition":
        return withVectorError(() => ({
          nextState: nextDeviceRequestState(
            requireString(input, "current") as DeviceRequestState,
            requireString(input, "event") as DeviceRequestEvent,
          ),
        }));
      case "device.maximum_queue_seconds":
        return withVectorError(() => ({
          seconds: maximumDeviceRequestQueueSeconds(
            requireString(input, "risk") as DeviceRequestRisk,
          ),
        }));
    }
  })();

  return projected.outcome === "value"
    ? {
        vectorId: vectorCase.id,
        operation: vectorCase.operation,
        outcome: "value",
        value: projected.value,
      }
    : {
        vectorId: vectorCase.id,
        operation: vectorCase.operation,
        outcome: "error",
        code: projected.code,
      };
};

const expectedProjection = (
  expected: VectorExpected,
): Readonly<Record<string, unknown>> =>
  expected.outcome === "value"
    ? { outcome: "value", value: expected.value }
    : { outcome: "error", code: expected.code };

const actualProjection = (
  actual: ConformanceActualResult,
): Readonly<Record<string, unknown>> =>
  actual.outcome === "value"
    ? { outcome: "value", value: actual.value }
    : { outcome: "error", code: actual.code };

const resultHashOf = (actual: ConformanceActualResult): string =>
  `sha256:${createHash("sha256")
    .update(
      Buffer.from(
        canonicalJson(
          actual.outcome === "value"
            ? {
                vectorId: actual.vectorId,
                operation: actual.operation,
                outcome: actual.outcome,
                value: actual.value,
              }
            : {
                vectorId: actual.vectorId,
                operation: actual.operation,
                outcome: actual.outcome,
                code: actual.code,
              },
        ),
        "utf8",
      ),
    )
    .digest("hex")}`;

const readVectorCases = (contractRoot: string): VectorCase[] => {
  const vectorsDirectory = join(contractRoot, "vectors");
  const cases: VectorCase[] = [];
  for (const fileName of CONFORMANCE_VECTOR_FILE_NAMES) {
    const document = asRecord(
      readJson(join(vectorsDirectory, fileName)),
      fileName,
    ) as Readonly<{ cases: readonly VectorCase[] }>;
    for (const vectorCase of document.cases) cases.push(vectorCase);
  }
  return cases;
};

/**
 * Evaluates every shared vector case with the OpenClaw TypeScript contract
 * stack and projects each one into the cross-host conformance record.
 */
export const runSharedVectors = (contractRoot?: string): ConformanceResult[] => {
  const root = resolveContractRoot(contractRoot);
  const sharedRegistry = loadSharedSchemaRegistry(root);
  return readVectorCases(root).map((vectorCase) => {
    const actual = runCase(vectorCase, sharedRegistry);
    const expected = vectorCase.expected;
    const status =
      canonicalJson(actualProjection(actual)) ===
      canonicalJson(expectedProjection(expected))
        ? "pass"
        : "fail";
    return {
      vectorId: actual.vectorId,
      operation: actual.operation,
      implementation: OPENCLAW_IMPLEMENTATION_ID,
      status,
      resultHash: resultHashOf(actual),
    };
  });
};
