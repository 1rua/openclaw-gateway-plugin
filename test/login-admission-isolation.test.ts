import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { coreSchemaHash } from "../../../gateway-contract/src/core-schema-hash.js";
import vectors from "../../../gateway-contract/vectors/protocol-negotiation.json" with { type: "json" };
import { createGatewayCore } from "../src/core/gateway-core.js";
import { composeGatewayServices } from "../src/host/channel-adapter.js";

const installation = { installationId: "install_1", displayName: "Phone", devicePublicKey: "A".repeat(43) };

describe("password admission isolation", () => {
  it("keeps malformed requests free, isolates accounts behind one peer, and ignores forwarded peer headers", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "oai-admission-"));
    const core = createGatewayCore({ storageRoot, attachmentMasterKey: Buffer.alloc(32, 0x65) });
    for (const id of ["alice", "bob"]) {
      const account = await core.openGatewayAccount(id);
      account.credentials.createPassword("correct password");
      account.close();
    }
    const { exposure } = composeGatewayServices({ core, hostVersion: "2026.7.1" });
    const server = createServer((req, res) => {
      const route = exposure.routes.find(value => value.path === req.url)!;
      void Promise.resolve(route.handler(req, res));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}/open-android-intelligence/v2`;
    const post = async (path: string, body: unknown, forwarded = "203.0.113.1") => {
      const response = await fetch(origin + path, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": forwarded }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as Record<string, any> };
    };
    const login = (username: string, password = "correct password") => ({ negotiationId: "neg_isolation", username, password, installation });
    try {
      const negotiation = structuredClone(vectors.cases[0]!.input.value!) as Record<string, any>;
      negotiation.negotiationId = "neg_isolation";
      negotiation.schemaHashes.core = coreSchemaHash();
      expect((await post("/negotiate", negotiation)).status).toBe(200);
      for (const malformed of [null, {}, [], { username: "alice" }]) {
        for (let i = 0; i < 10; i++) expect((await post("/sessions/password", malformed)).status).toBe(400);
      }
      expect((await post("/sessions/password", login("alice"))).status).toBe(200);
      for (let i = 0; i < 29; i++) expect((await post("/sessions/password", login("alice", "wrong password"))).status).toBe(401);
      expect((await post("/sessions/password", login("alice"), "198.51.100.2")).status).toBe(429);
      expect((await post("/sessions/password", login("bob"))).status).toBe(200);
      // The same account from another host-supplied peer has its own budget.
      expect(await core.handle({ method: "POST", target: "/open-android-intelligence/v2/sessions/password", remoteAddress: "198.51.100.3", body: login("alice") })).toHaveProperty("data.accessToken");
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      rmSync(storageRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
