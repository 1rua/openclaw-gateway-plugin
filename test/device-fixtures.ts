import registry from "../gateway-contract/vectors/dispatched-schema-fixtures.json" with { type:"json" };
import type { GatewayAccount } from "../src/core/gateway-core.js";
import type { DeviceCapabilityBinding } from "../src/core/capability-bindings.js";

/** Explicit setup for queue unit tests; there is no fixture binding in production. */
export const enqueueFixture = (account:GatewayAccount,input:Parameters<GatewayAccount["deviceRequests"]["enqueue"]>[0]) => {
  const fixture = registry.catalogEntries.find(entry => entry.key.kind === "device.request");
  if (fixture === undefined) throw new Error("DEVICE_REQUEST_FIXTURE_MISSING");
  const key = fixture.key;
  if (key.kind !== "device.request"
    || typeof key.pluginId !== "string"
    || typeof key.authorKeyId !== "string"
    || typeof key.capabilityId !== "string"
    || typeof key.capabilityVersion !== "string"
    || typeof key.schemaSha256 !== "string") {
    throw new Error("DEVICE_REQUEST_FIXTURE_INVALID");
  }
  const binding: DeviceCapabilityBinding = {
    pluginId: key.pluginId,
    authorKeyId: key.authorKeyId,
    capabilityId: key.capabilityId,
    capabilityVersion: key.capabilityVersion,
    schemaSha256: key.schemaSha256,
    schema: fixture.schema,
    risk: input.risk,
  };
  account.deviceRequests.capabilities.register(input.deviceId,input.pairingGeneration,input.grantRevision,[{
    ...binding,
  }]);
  return account.deviceRequests.enqueue(input);
};
