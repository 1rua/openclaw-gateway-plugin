import { createGatewayDispatchedValidator, gatewaySubschemaSha256 } from "../../../../gateway-contract/src/dispatched-schema-validator.js";
import { coreCatalog, coreBindings } from "./event-store.js";
import type { GatewayAccountStore } from "./account-store.js";
import type { DeviceRequestRisk } from "../../../../gateway-contract/src/state-machines.js";

export type DeviceCapabilityBinding = Readonly<{
  pluginId: string; authorKeyId: string; capabilityId: string; capabilityVersion: string;
  schemaSha256: string; schema: object; risk: DeviceRequestRisk;
}>;

export class CapabilityBindings {
  constructor(private readonly store: GatewayAccountStore) {}

  register(deviceId: string, generation: number, revision: number, bindings: readonly DeviceCapabilityBinding[]): void {
    this.validatePublication(bindings);
    this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)")
      .run(`device-capabilities:${deviceId}`,JSON.stringify({ generation,revision,bindings }));
  }

  /** Validation must finish before a publisher changes the pairing's grant revision. */
  validatePublication(bindings: readonly DeviceCapabilityBinding[]): void {
    if (!Array.isArray(bindings) || bindings.length > 128 || Buffer.byteLength(JSON.stringify(bindings),"utf8") > 262144) throw new Error("SCHEMA_INVALID");
    const keys = new Set<string>();
    for (const binding of bindings) {
      if (!binding || typeof binding !== "object" || Object.keys(binding).sort().join() !== ["pluginId","authorKeyId","capabilityId","capabilityVersion","schemaSha256","schema","risk"].sort().join()
        || [binding.pluginId,binding.authorKeyId,binding.capabilityId,binding.capabilityVersion,binding.schemaSha256,binding.risk].some(value=>typeof value !== "string")
        || !/^[A-Za-z0-9.-]+$/.test(binding.pluginId) || !/^sha256:[0-9a-f]{64}$/.test(binding.authorKeyId)
        || !binding.capabilityId.startsWith(`${binding.pluginId}.`) || !/^\d+\.\d+\.\d+$/.test(binding.capabilityVersion)
        || !["read","sync","write","high-privilege-ephemeral"].includes(binding.risk)
        || gatewaySubschemaSha256(binding.schema) !== binding.schemaSha256) throw new Error("SCHEMA_INVALID");
      const key = `${binding.capabilityId}@${binding.capabilityVersion}`;
      if (keys.has(key)) throw new Error("SCHEMA_INVALID");
      keys.add(key);
    }
    try { this.validator(bindings); } // Compile the restricted dialect before accepting a binding.
    catch { throw new Error("SCHEMA_INVALID"); }
  }

  list(deviceId: string, generation: number, revision: number): readonly DeviceCapabilityBinding[] {
    const row = this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`device-capabilities:${deviceId}`) as { value: string } | undefined;
    if (!row) return [];
    const saved = JSON.parse(row.value) as { generation: number; revision: number; bindings: DeviceCapabilityBinding[] };
    return saved.generation === generation && saved.revision === revision ? saved.bindings : [];
  }

  validate(deviceId: string, generation: number, revision: number, request: Readonly<Record<string,unknown>>): boolean {
    const bindings = this.list(deviceId,generation,revision);
    const provider = request.provider as Record<string,unknown> | undefined;
    const capability = request.capability as Record<string,unknown> | undefined;
    if (!bindings.some(binding => binding.pluginId === provider?.pluginId && binding.authorKeyId === provider?.authorKeyId &&
        binding.capabilityId === capability?.id && binding.capabilityVersion === capability?.version && binding.risk === request.risk)) return false;
    return this.validator(bindings).validate({kind:"device.request"},request).ok;
  }

  private validator(bindings: readonly DeviceCapabilityBinding[]) {
    const device = bindings.map(({ schema: _schema, risk: _risk, ...key }) => ({kind:"device.request" as const,...key}));
    return createGatewayDispatchedValidator([...coreCatalog,...bindings.map((binding,index) => ({key:device[index]!,schema:binding.schema}))],{core:coreBindings,device});
  }
}
