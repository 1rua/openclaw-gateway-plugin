import { describe, expect, it } from "vitest";
import { createOpenClawAdapter, OPENCLAW_PLUGIN_MANIFEST } from "./adapter.js";
import { fixtureBinding, fixtureContext, fixtureZeroRetentionEvidence } from "../shared/adapter.js";

describe("OpenClaw adapter", () => {
  it("uses one authoritative Gateway/plugin mapping and preserves binding", async () => {
    const adapter = createOpenClawAdapter({ context: fixtureContext(), zeroRetention: fixtureZeroRetentionEvidence() });
    await adapter.pair(fixtureBinding());
    expect(OPENCLAW_PLUGIN_MANIFEST.authoritativeProfiles).toEqual({ chat: "gateway", tool: "plugin", event: "plugin-hook" });
    await expect(adapter.sendAssistantMessage({ messageId: "m-1", text: "hello" }))
      .resolves.toMatchObject({ status: "accepted" });
    // Workspace/session are carried by the authenticated runtime context, not
    // by the device pairing record returned here.
    expect(adapter.binding()).toMatchObject({ tenantId: "tenant-a", deviceId: "device-a" });
  });

  it("accepts the shared bounded audio attachment contract", async () => {
    const adapter = createOpenClawAdapter({ context: fixtureContext(), zeroRetention: fixtureZeroRetentionEvidence() });
    await adapter.pair(fixtureBinding());
    await expect(adapter.sendAssistantMessage({
      messageId: "voice-1", text: "analyze this",
      attachments: [{ kind: "audio", artifactId: "artifact-audio", filename: "voice.m4a", mimeType: "audio/mp4", sizeBytes: 512, sha256: "c".repeat(64), durationMs: 5000 }],
    })).resolves.toMatchObject({ status: "accepted" });
  });

  it("normalizes its result without backend-specific identity fields", async () => {
    const adapter = createOpenClawAdapter({ context: fixtureContext(), zeroRetention: fixtureZeroRetentionEvidence() });
    await adapter.pair(fixtureBinding());
    const response = await adapter.sendAssistantMessage({ messageId: "m-1", text: "hello" });
    expect(Object.keys(response).sort()).toEqual(["messageId", "reply", "status"]);
  });

  it("routes the closed SMS operations through the shared adapter", async () => {
    const adapter = createOpenClawAdapter({
      context: fixtureContext(),
      zeroRetention: fixtureZeroRetentionEvidence(),
      onDemandSms: async () => [],
    });
    await adapter.pair(fixtureBinding());
    await expect(adapter.invokeTool("mobile.sms.query", { toolCallId: "openclaw-sms", deviceId: "device-a", limit: 1 }))
      .resolves.toEqual([]);
    expect(OPENCLAW_PLUGIN_MANIFEST.tools).toEqual([
      "mobile.notifications.query", "mobile.notifications.subscribe", "mobile.notifications.unsubscribe",
      "mobile.sms.query", "mobile.sms.subscribe", "mobile.sms.unsubscribe",
    ]);
  });
});
