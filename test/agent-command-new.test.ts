import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createGatewayCore } from "../src/core/gateway-core.js";

const tempRoot = (): string => mkdtempSync(join(tmpdir(), "open-android-intelligence-openclaw-new-command-"));

const context = (requestId: string, correlationId: string) => ({
  accountId: "acct_alice",
  deviceId: "dev_1",
  sessionId: "sess_1",
  requestId,
  correlationId,
  pairingGeneration: 1,
  grantRevision: 1,
});

describe("OpenClaw and the `/new` command entry", () => {
  it("accepts `/new` as ordinary text and never pretends to create a conversation", async () => {
    const storageRoot = tempRoot();
    const core = createGatewayCore({ storageRoot });
    const account = await core.openGatewayAccount("acct_alice");
    const source = account.conversations.create({
      clientConversationId: "conv_client_source",
      title: "Source thread",
      correlationId: "cor_source",
    });
    account.close();

    const accepted = await core.handle({
      context: context("req_new_command", "cor_new_command"),
      method: "POST",
      target: `/open-android-intelligence/v2/conversations/${source.conversationId}/messages`,
      idempotencyKey: "req_new_command",
      body: { clientMessageId: "msg_new_command", text: "/new", attachments: [] },
    });

    // No command entry here means no command result: the text is simply a
    // message the Agent will have to interpret however it sees fit.
    expect(accepted).toMatchObject({ data: { message: { status: "accepted" } } });

    const reopened = await core.openGatewayAccount("acct_alice");
    const threads = reopened.conversations.list();
    const events = reopened.events.readAfter(null);
    reopened.close();

    expect(threads.map((thread) => thread.conversationId)).toEqual([source.conversationId]);
    expect(events.some((event) => event.eventType === "conversation.command.result")).toBe(false);
  });
});
