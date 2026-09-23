import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";
import { createGatewayRoutes } from "../src/http/routes.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "oai-openclaw-sse-status-"));
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const sseRequest = (): IncomingMessage => Object.assign(Readable.from([]), {
  method: "GET",
  url: "/open-android-intelligence/v2/events",
  headers: { accept: "text/event-stream", authorization: "Bearer test" },
  rawHeaders: ["Accept", "text/event-stream", "Authorization", "Bearer test"],
}) as unknown as IncomingMessage;

const sseResponse = (): Readonly<{
  response: ServerResponse & EventEmitter;
  chunks: string[];
  headers: Record<string, string>;
  close: () => void;
}> => {
  const emitter = new EventEmitter();
  const chunks: string[] = [];
  const headers: Record<string, string> = {};
  let ended = false;
  const response = Object.assign(emitter, {
    statusCode: 0,
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    setHeader(name: string, value: string): void { headers[name.toLowerCase()] = value; },
    flushHeaders(): void { this.headersSent = true; },
    write(value: string): boolean { chunks.push(value); return true; },
    end(): void { ended = true; this.writableEnded = true; emitter.emit("close"); },
  }) as unknown as ServerResponse & EventEmitter;
  return Object.freeze({
    response,
    chunks,
    headers,
    close: (): void => {
      if (ended) return;
      response.destroyed = true;
      response.emit("close");
    },
  });
};

describe("OpenClaw conversation status SSE", () => {
  it("replays from the cursor and pushes events committed through an independent account handle", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot(), attachmentMasterKey: Buffer.alloc(32, 0x45) });
    const writer = await core.openGatewayAccount("acct_sse");
    const conversation = writer.conversations.create({ clientConversationId: "client_conv_sse", correlationId: "cor_sse_create" });
    writer.events.append({
      eventType: "conversation.message.status",
      correlationId: "cor_status_queued",
      payload: { conversationId: conversation.conversationId, messageId: "msg_sse", clientMessageId: "client_sse", status: "queued", revision: 0, errorCode: null },
    });
    const routes = createGatewayRoutes({
      core,
      hostVersion: "2026.7.1-2",
      verifyRequest: (input) => ({
        context: {
          accountId: "acct_sse",
          deviceId: "device_sse",
          sessionId: "session_sse",
          requestId: "request_sse",
          correlationId: "correlation_sse",
          pairingGeneration: 1,
          grantRevision: 1,
        },
        method: input.method,
        target: input.target,
      }),
    });
    const route = routes.find((item) => item.path === "/open-android-intelligence/v2/events");
    if (route?.handler === undefined) throw new Error("event route missing");
    const client = sseResponse();
    const serving = route.handler(sseRequest(), client.response);
    for (let i = 0; i < 100 && client.chunks.length === 0; i += 1) await pause(5);

    expect(client.headers["content-type"]).toContain("text/event-stream");
    expect(client.chunks.join("")).toContain("event: conversation.message.status");
    expect(client.chunks.join("")).toContain('"status":"queued"');

    const independentWriter = await core.openGatewayAccount("acct_sse");
    independentWriter.store.transaction(() => {
      independentWriter.events.append({
        eventType: "conversation.message.status",
        correlationId: "cor_status_delivered",
        payload: { conversationId: conversation.conversationId, messageId: "msg_sse", clientMessageId: "client_sse", status: "delivered", revision: 1, errorCode: null },
      });
      // The event is transactionally persisted but must not be pushed pre-commit.
      expect(client.chunks.join("")).not.toContain('"status":"delivered"');
    });
    independentWriter.close();

    for (let i = 0; i < 100 && !client.chunks.join("").includes('"status":"delivered"'); i += 1) await pause(5);
    expect(client.chunks.join("")).toContain('"status":"delivered"');
    expect(client.chunks.join("")).toContain("id: evt_");

    const beforeClose = client.chunks.length;
    client.close();
    await serving;
    const afterCloseWriter = await core.openGatewayAccount("acct_sse");
    afterCloseWriter.events.append({
      eventType: "conversation.message.status",
      correlationId: "cor_status_completed",
      payload: { conversationId: conversation.conversationId, messageId: "msg_sse", clientMessageId: "client_sse", status: "completed", revision: 2, errorCode: null },
    });
    afterCloseWriter.close();
    await pause(20);
    expect(client.chunks).toHaveLength(beforeClose);
    writer.close();
  });
});
