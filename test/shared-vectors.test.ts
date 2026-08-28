import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";
import {
  CONFORMANCE_VECTOR_FILE_NAMES,
  resolveContractRoot,
} from "../src/core/shared-vectors.js";

const contractRoot = resolveContractRoot();
const vectorsDirectory = join(contractRoot, "vectors");

const readVectorFile = (fileName: string): { cases: ReadonlyArray<{ id: string }> } =>
  JSON.parse(readFileSync(join(vectorsDirectory, fileName), "utf8")) as {
    cases: ReadonlyArray<{ id: string }>;
  };

/** Copies only the contract assets a runner consumes, so nothing in the repo is mutated. */
const copyContractTo = (targetRoot: string): string => {
  const target = join(targetRoot, "gateway-contract");
  cpSync(join(contractRoot, "schemas"), join(target, "schemas"), { recursive: true });
  cpSync(vectorsDirectory, join(target, "vectors"), { recursive: true });
  return targetRoot;
};

describe("OpenClaw Gateway shared vector consumption", () => {
  it("consumes the shared schema and vector registry with no local fixture copy", () => {
    const discovered = new Set(
      readdirSync(vectorsDirectory).filter(
        (name) =>
          name.endsWith(".json") &&
          !name.endsWith(".schema.json") &&
          name !== "dispatched-schema-fixtures.json",
      ),
    );
    expect(discovered).toEqual(new Set(CONFORMANCE_VECTOR_FILE_NAMES));

    const expectedCases = CONFORMANCE_VECTOR_FILE_NAMES.flatMap(
      (fileName) => readVectorFile(fileName).cases,
    );
    expect(expectedCases.length).toBeGreaterThan(0);
    expect(new Set(expectedCases.map((item) => item.id)).size).toBe(expectedCases.length);

    const results = createGatewayCore().runSharedVectors();
    expect(results.map((result) => result.vectorId)).toEqual(
      expectedCases.map((item) => item.id),
    );
    expect(new Set(results.map((result) => result.status))).toEqual(new Set(["pass"]));
    expect(new Set(results.map((result) => result.implementation))).toEqual(
      new Set(["openclaw-typescript"]),
    );
    for (const result of results) {
      expect(result.resultHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("fails closed when the one shared fixture registry is substituted", () => {
    const root = copyContractTo(mkdtempSync(join(tmpdir(), "agent-life-openclaw-vectors-")));
    const registryPath = join(root, "gateway-contract", "vectors", "dispatched-schema-fixtures.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      catalogEntries: Array<{ key: { schemaSha256: string } }>;
    };
    registry.catalogEntries[0]!.key.schemaSha256 = `sha256:${"f".repeat(64)}`;
    writeFileSync(registryPath, JSON.stringify(registry), "utf8");

    expect(() => createGatewayCore().runSharedVectors(root)).toThrow(
      "INVALID_FIXTURE_REGISTRY",
    );
  });
});
