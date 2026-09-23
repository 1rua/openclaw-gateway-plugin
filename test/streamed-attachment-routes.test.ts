import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it, vi } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";
import { createGatewayRoutes, type GatewayRequestVerifierInput } from "../src/http/routes.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-stream-route-"));
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const STREAM_CHUNK_BYTES = 64 * 1024;

const patternedChunk = (offset: number, length: number): Buffer => Buffer.alloc(length, Math.floor(offset / STREAM_CHUNK_BYTES) % 251);

const patternedDigest = (length: number): string => {
  const hash = createHash("sha256");
  for (let offset = 0; offset < length; offset += STREAM_CHUNK_BYTES) {
    hash.update(patternedChunk(offset, Math.min(STREAM_CHUNK_BYTES, length - offset)));
  }
  return hash.digest("hex");
};

async function* patternedStream(length: number): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < length; offset += STREAM_CHUNK_BYTES) {
    yield patternedChunk(offset, Math.min(STREAM_CHUNK_BYTES, length - offset));
  }
}

async function* bytesStream(bytes: Uint8Array): AsyncGenerator<Uint8Array> { yield bytes; }

const rawRequest = (
  source: AsyncIterable<Uint8Array>,
  length: number,
  digest: string,
  target: string,
  rawHeaders: string[],
): IncomingMessage => Object.assign(
  Readable.from(source),
  {
    method: "PUT",
    url: target,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(length),
      digest: `sha-256=${Buffer.from(digest, "hex").toString("base64")}`,
      authorization: "Bearer test-token",
    },
    rawHeaders,
  },
) as unknown as IncomingMessage;

const rawResponse = (): Readonly<{ response: ServerResponse; state: { statusCode: number; headers: Record<string, string>; body: string } }> => {
  const state = { statusCode: 0, headers: {} as Record<string, string>, body: "" };
  const response = {
    setHeader: (name: string, value: string): void => { state.headers[name.toLowerCase()] = value; },
    end: (body?: string): void => { state.body = body ?? ""; },
  } as unknown as ServerResponse;
  Object.defineProperty(response, "statusCode", { get: () => state.statusCode, set: (value: number) => { state.statusCode = value; } });
  return { response, state };
};

describe("OpenClaw raw attachment PUT", () => {
  it("authenticates the signed Digest header and accepts streams larger than the JSON body reader limit", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x54) });
    const account = await core.openGatewayAccount("acct_stream");
    const verifierInputs: GatewayRequestVerifierInput[] = [];
    const routes = createGatewayRoutes({
      core,
      hostVersion: "2026.7.1-2",
      maxBodyBytes: 8,
      verifyRequest: (input) => {
        verifierInputs.push(input);
        return {
          context: {
            accountId: "acct_stream",
            deviceId: "device_stream",
            sessionId: "session_stream",
            requestId: input.target.split("/").at(-2) ?? "request_stream",
            correlationId: "correlation_stream",
            pairingGeneration: 1,
            grantRevision: 1,
          },
          method: input.method,
          target: input.target,
          idempotencyKey: input.target.split("/").at(-2) ?? "request_stream",
        };
      },
    });
    const route = routes.find((item) => item.path === "/open-android-intelligence/v2/attachments/");
    if (route === undefined) throw new Error("attachment prefix route missing");
    const lengths = [1 * 1024 * 1024 + 1, 25 * 1024 * 1024 + 1, 50 * 1024 * 1024 + 1];
    for (const [index, length] of lengths.entries()) {
      const digest = patternedDigest(length);
      const attachment = account.attachments.create({
        clientAttachmentId: `att_stream_route_${index}`,
        filename: `agent-owned-format-${index}.bin`,
        mediaType: "application/x-agent-format",
        sizeBytes: length,
        sha256: digest,
        correlationId: `cor_stream_route_${index}`,
      });
      const target = `/open-android-intelligence/v2/attachments/${attachment.attachmentId}/content`;
      const requestId = attachment.attachmentId;
      const digestHeader = `sha-256=${Buffer.from(digest, "hex").toString("base64")}`;
      const request = rawRequest(patternedStream(length), length, digest, target, [
        "Content-Length", String(length),
        "Digest", digestHeader,
        "Authorization", "Bearer test-token",
      ]);
      const { response, state } = rawResponse();
      await route.handler(request, response);
      expect(state.statusCode).toBe(200);
      expect(JSON.parse(state.body)).toMatchObject({ data: { attachment: { attachmentId: attachment.attachmentId, status: "staged" } } });
      expect(verifierInputs.at(-1)?.body.byteLength).toBe(0);
      expect(verifierInputs.at(-1)?.declaredBodyDigestHex).toBe(digest);
      expect(account.attachments.get(attachment.attachmentId).state).toBe("uploading");
      await expect(core.handle({
        context: {
          accountId: "acct_stream",
          deviceId: "device_stream",
          sessionId: "session_stream",
          requestId: `commit_${requestId}`,
          correlationId: `correlation_commit_${index}`,
          pairingGeneration: 1,
          grantRevision: 1,
        },
        method: "POST",
        target: `/open-android-intelligence/v2/attachments/${attachment.attachmentId}/commit`,
        idempotencyKey: `commit_${requestId}`,
      })).resolves.toMatchObject({ data: { attachment: { status: "uploaded" } } });
    }
    account.close();
  });

  it("rejects duplicate and encoded/chunked attachment framing before authentication", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x54) });
    const verifier = vi.fn(() => undefined);
    const routes = createGatewayRoutes({ core, hostVersion: "2026.7.1-2", verifyRequest: verifier });
    const route = routes.find((item) => item.path === "/open-android-intelligence/v2/attachments/");
    if (route === undefined) throw new Error("attachment prefix route missing");
    const payload = new TextEncoder().encode("duplicate header test");
    const digest = `sha-256=${Buffer.from(sha256(payload), "hex").toString("base64")}`;
    const invalidHeaders = [
      ["Content-Length", String(payload.byteLength), "Content-Length", String(payload.byteLength), "Digest", digest],
      ["Content-Length", String(payload.byteLength), "Digest", digest, "Digest", digest],
      ["Content-Length", String(payload.byteLength), "Digest", digest, "Content-Encoding", "gzip"],
      ["Content-Length", String(payload.byteLength), "Digest", digest, "Transfer-Encoding", "chunked"],
    ];
    for (const headers of invalidHeaders) {
      const { response, state } = rawResponse();
      await route.handler(rawRequest(bytesStream(payload), payload.byteLength, sha256(payload), "/open-android-intelligence/v2/attachments/att_x/content", headers), response);
      expect(state.statusCode).toBe(400);
    }
    expect(verifier).not.toHaveBeenCalled();
  });
});
