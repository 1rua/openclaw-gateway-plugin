import { describe, expect, it } from "vitest";

import type { GatewayCore } from "../src/core/gateway-core.js";

const fakeCore = (writes: { count: number }): GatewayCore => ({
  openGatewayAccount: async (accountId) => {
    writes.count += 1;
    return { accountId, close: () => undefined } as never;
  },
  handle: async () => {
    throw new Error("not used by admin service");
  },
});

describe("OpenClaw Agent-life admin surfaces", () => {
  it("uses one AdminService implementation for host UI and local CLI", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("runAdminCommand" in legacyAdapter).toBe(true);

    const { createAdminPanel, createAdminService } = await import("../src/admin/service.js");
    const { bindAdminService, runAdminCommand } = await import("../src/admin/cli.js");
    const writes = { count: 0 };
    const service = createAdminService({ core: fakeCore(writes), hostVersion: "2026.7.1" });
    const ui = createAdminPanel(service);
    bindAdminService(service);
    const input = Object.freeze({ accountId: "account-a" });

    await expect(ui.createAccount(input)).resolves.toEqual(
      await runAdminCommand(["account", "create", input.accountId]),
    );
    expect(writes.count).toBe(2);
  });

  it("keeps an incompatible host admin surface read-only", async () => {
    const legacyAdapter = await import("../adapter.js");
    expect("createAdminService" in legacyAdapter).toBe(true);

    const { createAdminPanel, createAdminService } = await import("../src/admin/service.js");
    const { bindAdminService, runAdminCommand } = await import("../src/admin/cli.js");
    const writes = { count: 0 };
    const service = createAdminService({ core: fakeCore(writes), hostVersion: "2026.8.0" });
    const ui = createAdminPanel(service);
    bindAdminService(service);

    await expect(ui.createAccount({ accountId: "account-a" })).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_INCOMPATIBLE" },
      readOnly: true,
    });
    await expect(runAdminCommand(["account", "create", "account-a"])).resolves.toMatchObject({
      ok: false,
      error: { code: "HOST_INCOMPATIBLE" },
      readOnly: true,
    });
    expect(writes.count).toBe(0);
  });
});
