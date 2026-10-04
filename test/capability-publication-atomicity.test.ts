import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { gatewaySubschemaSha256 } from "../../../gateway-contract/src/dispatched-schema-validator.js";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";

it("rejects an invalid publication and its replay without changing grants, bindings, audit or pending requests", async () => {
  const core = createGatewayCore({ storageRoot: mkdtempSync(join(tmpdir(),"oai-publication-")), attachmentMasterKey: Buffer.alloc(32,5) });
  const account = await core.openGatewayAccount("acct_publication");
  let context: VerifiedRequestContext;
  const schema = { type:"object", additionalProperties:false };
  const binding = { pluginId:"org.example.actual", authorKeyId:`sha256:${"a".repeat(64)}`,
    capabilityId:"org.example.actual.read", capabilityVersion:"1.0.0", schemaSha256:gatewaySubschemaSha256(schema), schema, risk:"read" as const };
  try {
    account.credentials.setPassword("test-password");
    const session = account.sessions.createPasswordSession({ username:"acct_publication", password:"test-password",
      installation:{installationId:"install_publication",displayName:"phone",devicePublicKey:"A".repeat(43)}, correlationId:"cor_login" });
    context = { accountId:"acct_publication", deviceId:session.deviceId, sessionId:session.sessionId,
      requestId:"req_seed", correlationId:"cor_publication", pairingGeneration:1, grantRevision:1 };
    account.deviceRequests.capabilities.register(context.deviceId,1,1,[binding]);
    account.deviceRequests.enqueue({ ...context, requestId:"request_existing", risk:"read",
      capability:{id:binding.capabilityId,version:binding.capabilityVersion},
      provider:{pluginId:binding.pluginId,authorKeyId:binding.authorKeyId}, parameters:{} });
  } finally { account.close(); }
  const snapshot = async () => {
    const a = await core.openGatewayAccount(context.accountId);
    try { return {
      device:a.store.database.prepare("SELECT grant_revision FROM device_keys WHERE device_id=?").get(context.deviceId),
      metadata:a.store.database.prepare("SELECT key,value FROM account_metadata WHERE key IN (?,?) ORDER BY key")
        .all(`device-capabilities:${context.deviceId}`,`device-grant-digest:${context.deviceId}`),
      events:a.store.database.prepare("SELECT * FROM events ORDER BY rowid").all(),
      audit:a.store.database.prepare("SELECT * FROM audit_events ORDER BY rowid").all(),
      request:a.deviceRequests.get("request_existing"),
    }; } finally { a.close(); }
  };
  const before = await snapshot();
  const unsupported = { ...schema, not:{} };
  const oversized = {...schema,description:"汉".repeat(90_000)};
  const malformed = [null, [null], [{...binding,risk:{}}], [{...binding,schemaSha256:`sha256:${"0".repeat(64)}`}],
    [{...binding,schema:unsupported,schemaSha256:gatewaySubschemaSha256(unsupported)}], Array(129).fill(binding)];
  malformed.push([{...binding,schema:oversized,schemaSha256:gatewaySubschemaSha256(oversized)}]);
  for (const [index, bindings] of malformed.entries()) {
    const requestId = `req_bad_${index}`;
    const request = { method:"POST" as const, target:"/open-android-intelligence/v2/pairings/current/capabilities",
      context:{...context,requestId}, idempotencyKey:requestId, body:{bindings,expectedGrantRevision:1,localGrantRevision:2} };
    const failure = await core.handle(request);
    expect(failure.error).toMatchObject({code:"SCHEMA_INVALID"});
    expect(await core.handle(request)).toEqual(failure);
    expect(await snapshot()).toEqual(before);
  }
  const result = await core.handle({method:"GET",target:"/open-android-intelligence/v2/device-requests/request_existing",context});
  expect(result.data).toHaveProperty("request.state","pending");
  const accepted = await core.handle({method:"POST",target:"/open-android-intelligence/v2/pairings/current/capabilities",
    context:{...context,requestId:"req_valid"},idempotencyKey:"req_valid",
    body:{bindings:[binding],expectedGrantRevision:1,localGrantRevision:2}});
  expect(accepted.data).toHaveProperty("grantRevision",2);
  const a = await core.openGatewayAccount(context.accountId);
  try {
    expect(a.deviceRequests.capabilities.list(context.deviceId,1,2)).toEqual([binding]);
    expect(a.events.readAfter(null).filter(e=>e.eventType==="pairing.grant.changed")).toHaveLength(1);
  } finally { a.close(); }
});
