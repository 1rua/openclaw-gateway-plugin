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

  it("normalizes its result without backend-specific identity fields", async () => {
    const adapter = createOpenClawAdapter({ context: fixtureContext(), zeroRetention: fixtureZeroRetentionEvidence() });
    await adapter.pair(fixtureBinding());
    const response = await adapter.sendAssistantMessage({ messageId: "m-1", text: "hello" });
    expect(Object.keys(response).sort()).toEqual(["messageId", "reply", "status"]);
  });
});
