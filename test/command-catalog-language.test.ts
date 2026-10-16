import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";

const context: VerifiedRequestContext = {
  accountId: "acct_command_language",
  deviceId: "dev_command_language",
  sessionId: "sess_command_language",
  requestId: "req_command_language",
  correlationId: "cor_command_language",
  pairingGeneration: 1,
  grantRevision: 1,
};

const commandCatalogLanguage = async (target: string): Promise<string> => {
  const core = createGatewayCore({
    storageRoot: mkdtempSync(join(tmpdir(), "oai-command-language-")),
    attachmentMasterKey: Buffer.alloc(32, 9),
  });
  core.setCommandCatalogProvider?.(async () => []);
  const response = await core.handle({ context, method: "GET", target });
  if (response.error) throw new Error(response.error.code);
  return String(response.data?.languageCode ?? "");
};

describe("command catalog languageCode", () => {
  it.each([
    ["missing", "/open-android-intelligence/v2/commands"],
    ["empty", "/open-android-intelligence/v2/commands?languageCode="],
    ["whitespace", "/open-android-intelligence/v2/commands?languageCode=%20%20"],
  ])("uses the schema-valid English fallback when languageCode is %s", async (_caseName, target) => {
    await expect(commandCatalogLanguage(target)).resolves.toBe("en");
  });

  it("preserves a normal language label", async () => {
    await expect(commandCatalogLanguage("/open-android-intelligence/v2/commands?languageCode=zh-CN"))
      .resolves.toBe("zh-CN");
  });
});
