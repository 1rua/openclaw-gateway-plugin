import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore, openGatewayAccount } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "agent-life-openclaw-isolation-"));

describe("OpenClaw Gateway account isolation", () => {
  it("opens different accounts under separate file roots before any shared database exists", async () => {
    const originalCwd = process.cwd();
    process.chdir(tempRoot());
    const alice = await openGatewayAccount("acct_alice");
    const bob = await openGatewayAccount("acct_bob");

    try {
      expect(alice.paths.database).not.toBe(bob.paths.database);
      expect(alice.paths.attachments.startsWith(bob.paths.root)).toBe(false);
    } finally {
      process.chdir(originalCwd);
    }

    alice.close();
    bob.close();
  });

  it("does not share SSE cursors or conversation attachment references across account databases", async () => {
    const core = createGatewayCore({ storageRoot: tempRoot() });
    const alice = await core.openGatewayAccount("acct_alice");
    const bob = await core.openGatewayAccount("acct_bob");

    const event = alice.events.append({
      eventType: "gateway.notice",
      correlationId: "cor_evt",
      payload: { summary: "ready" },
      now: new Date("2026-08-24T12:00:00.000Z"),
    });
    expect(alice.events.readAfter(null, new Date("2026-08-24T12:00:01.000Z")).map((item) => item.eventId)).toContain(event.eventId);
    expect(() => bob.events.readAfter(event.eventId)).toThrowError("CURSOR_EXPIRED");
    expect(() => alice.events.readAfter(event.eventId, new Date("2026-08-25T12:00:01.000Z"))).toThrowError("CURSOR_EXPIRED");

    const conversation = bob.conversations.create({
      clientConversationId: "conv_client_bob",
      title: "Bob thread",
      correlationId: "cor_bob_conversation",
    });
    expect(() =>
      bob.conversations.acceptMessage({
        conversationId: conversation.conversationId,
        clientMessageId: "msg_client_bob",
        text: "use alice attachment",
        attachmentIds: ["att_alice_only"],
        deviceId: "dev_bob",
        requestId: "req_bob_message",
        correlationId: "cor_bob_message",
      }),
    ).toThrowError("ATTACHMENT_EXPIRED");

    const auditJson = JSON.stringify(bob.audit.list());
    expect(auditJson).not.toContain("use alice attachment");

    alice.close();
    bob.close();
  });
});
