import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_ROOT_ENVIRONMENT_VARIABLE } from "../src/core/account-paths.js";
import { createGatewayCore } from "../src/core/gateway-core.js";

const ROOT_VARIABLE = DEFAULT_ROOT_ENVIRONMENT_VARIABLE;

const setEnvironment = (value: string | undefined): void => {
  if (value === undefined) {
    delete process.env[ROOT_VARIABLE];
  } else {
    process.env[ROOT_VARIABLE] = value;
  }
};

describe("OpenClaw Gateway storage root", () => {
  afterEach(() => {
    setEnvironment(undefined);
  });

  it("never invents a storage root from the current working directory", async () => {
    setEnvironment(undefined);
    const core = createGatewayCore();

    // Operating without storage still works: shared vectors need no data root.
    expect(() => core.runSharedVectors()).not.toThrow();

    // A storage-backed call fails loudly instead of writing beside the shell.
    await expect(core.openGatewayAccount("acct_alice")).rejects.toThrowError("STORAGE_ROOT_REQUIRED");
    expect(() => core.accountExists("acct_alice")).toThrowError("STORAGE_ROOT_REQUIRED");
    expect(existsSync(join(process.cwd(), ".open-android-intelligence-openclaw"))).toBe(false);
  });

  it("uses the configured root when the host names none", async () => {
    const configured = mkdtempSync(join(tmpdir(), "openclaw-root-"));
    setEnvironment(configured);
    const core = createGatewayCore();

    const account = await core.openGatewayAccount("acct_alice");
    try {
      expect(account.accountId).toBe("acct_alice");
    } finally {
      account.close();
    }

    expect(existsSync(join(configured, "accounts"))).toBe(true);
    expect(existsSync(join(process.cwd(), ".open-android-intelligence-openclaw"))).toBe(false);
  });

  it("prefers the host data directory over both the environment and the shell", async () => {
    const host = mkdtempSync(join(tmpdir(), "openclaw-host-"));
    const configured = mkdtempSync(join(tmpdir(), "openclaw-env-"));
    setEnvironment(configured);
    const core = createGatewayCore({ storageRoot: host });

    const account = await core.openGatewayAccount("acct_alice");
    account.close();

    expect(existsSync(host)).toBe(true);
    expect(existsSync(join(configured, "accounts"))).toBe(false);
  });
});
