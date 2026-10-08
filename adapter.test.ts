import { describe, expect, it } from "vitest";
import { OPENCLAW_PLUGIN, OPENCLAW_PLUGIN_MANIFEST, OPENCLAW_TOOL_NAMES } from "./adapter.js";
import hostManifest from "./openclaw.plugin.json" with { type: "json" };
import packageMetadata from "./package.json" with { type: "json" };

describe("OpenClaw native package entry", () => {
  it("exports the stable plugin identity and registration entry", () => {
    expect(OPENCLAW_PLUGIN.id).toBe("open-android-intelligence-gateway");
    expect(OPENCLAW_PLUGIN.name).toBe("Open Android Intelligence Gateway");
    expect(typeof OPENCLAW_PLUGIN.register).toBe("function");
  });

  it("keeps protocol, host compatibility, and implemented tools explicit", () => {
    expect(OPENCLAW_PLUGIN_MANIFEST.protocolVersion).toBe("2.1.0");
    expect(OPENCLAW_PLUGIN_MANIFEST.hostApi).toEqual({
      min: "2026.7.1",
      max: "2026.7.1",
      commit: "0790d9f593ad30c940ed93b5872a8cf6d6f3cf8c",
    });
    expect(Object.isFrozen(OPENCLAW_TOOL_NAMES)).toBe(true);
    expect(OPENCLAW_PLUGIN_MANIFEST.tools).toEqual([
      "mobile.notifications.query", "mobile.notifications.subscribe", "mobile.notifications.unsubscribe",
      "mobile.sms.query", "mobile.sms.subscribe", "mobile.sms.unsubscribe",
    ]);
    expect(hostManifest.id).toBe(OPENCLAW_PLUGIN.id);
    expect(hostManifest.contracts.tools).toEqual(["open_android_device"]);
    expect(packageMetadata.openclaw.extensions).toEqual(["./adapter.ts"]);
    expect(packageMetadata.openclaw.runtimeExtensions).toEqual(["./runtime/adapter.js"]);
  });
});
