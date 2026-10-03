import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import canonicalize from "canonicalize";
import type { GatewayCore } from "../core/gateway-core.js";

type Origin = Readonly<{ deviceId:string;pairingGeneration:number;grantRevision:number;conversationId:string;messageId:string;clientMessageId:string }>;
type Turn = Readonly<{ accountId:string;messageId:string;sessionKey?:string }>;
export const trustedDeviceTurn = new AsyncLocalStorage<Turn>();
export const DEVICE_TOOL_NAME = "open_android_device";
type ToolContext = Readonly<{sessionKey?:string;messageChannel?:string;requesterSenderId?:string}>;
type ToolResult = Readonly<{content:readonly Readonly<{type:"text";text:string}>[];details:Readonly<Record<string,unknown>>}>;
export type DeviceToolApi = Readonly<{
  registerTool?: (factory:(context:ToolContext) => Readonly<{name:string;label:string;description:string;parameters:unknown;
    execute:(callId:string,args:unknown,signal?:AbortSignal) => Promise<ToolResult>}> | null,options?:Readonly<{name?:string;optional?:boolean}>) => void;
  on?: (name:"after_tool_call",handler:(event:Readonly<{toolName:string;toolCallId?:string;result?:unknown;error?:string}>,context:Readonly<{sessionKey?:string;toolCallId?:string}>) => Promise<void>) => void;
}>;
const record = (value:unknown):Record<string,unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string,unknown> : {};
const hash = (value:unknown):string => createHash("sha256").update(canonicalize(value) ?? "null").digest("hex");

/** This factory uses the SDK's trusted session context and the authenticated inbound origin. */
export const registerDeviceTools = (api:DeviceToolApi,core:GatewayCore):void => {
  if (!api.registerTool || !api.on) return;
  const adopted = new Map<string,{accountId:string;requestId:string;claimId:string;sessionKey:string;hash:string}>();
  api.registerTool((context) => {
    const turn = trustedDeviceTurn.getStore();
    if (!turn || context.messageChannel !== "open-android-intelligence-gateway" || !context.sessionKey) return null;
    return {
      name:DEVICE_TOOL_NAME,label:"Android device capability",
      description:"Invoke a capability explicitly granted on the paired Android phone. The host selects device, provider and risk.",
      parameters:{type:"object",additionalProperties:false,required:["capabilityId","capabilityVersion","parameters"],properties:{
        capabilityId:{type:"string",maxLength:256},capabilityVersion:{type:"string",pattern:"^\\d+\\.\\d+\\.\\d+$"},parameters:{type:"object"}}},
      execute:async (callId,args,signal) => {
        const input = record(args);
        if (Object.keys(input).sort().join() !== ["capabilityId","capabilityVersion","parameters"].sort().join() || !input.parameters || Array.isArray(input.parameters) || typeof input.parameters !== "object") throw new Error("SCHEMA_INVALID");
        let account = await core.openGatewayAccount(turn.accountId);
        let origin:Origin; let requestId:string; let expiresAt:string;
        try {
          const saved = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`message-device:${turn.messageId}`) as {value:string} | undefined;
          if (!saved) throw new Error("PAIRING_REQUIRED");
          origin = JSON.parse(saved.value) as Origin;
          const session = account.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(`host-session:${origin.conversationId}`) as {value:string} | undefined;
          if (!session || JSON.parse(session.value).sessionKey !== context.sessionKey) throw new Error("PAIRING_REQUIRED");
          const device = account.store.database.prepare("SELECT pairing_generation,grant_revision FROM device_keys WHERE device_id=?").get(origin.deviceId) as {pairing_generation:number;grant_revision:number} | undefined;
          if (!device || device.pairing_generation !== origin.pairingGeneration || device.grant_revision !== origin.grantRevision) throw new Error("GRANT_STALE");
          const binding = account.deviceRequests.capabilities.list(origin.deviceId,origin.pairingGeneration,origin.grantRevision).find(item => item.capabilityId === input.capabilityId && item.capabilityVersion === input.capabilityVersion);
          if (!binding) throw new Error("CAPABILITY_DENIED");
          requestId = `devreq_${randomUUID()}`;
          const request = account.deviceRequests.enqueue({requestId,deviceId:origin.deviceId,pairingGeneration:origin.pairingGeneration,grantRevision:origin.grantRevision,
            capability:{id:binding.capabilityId,version:binding.capabilityVersion},provider:{pluginId:binding.pluginId,authorKeyId:binding.authorKeyId},parameters:record(input.parameters),
            risk:binding.risk,correlationId:origin.messageId,requiresForegroundConfirmation:["write","high-privilege-ephemeral"].includes(binding.risk),
            online:core.isDeviceOnline?.(turn.accountId,origin.deviceId,origin.pairingGeneration) === true});
          expiresAt = request.expiresAt;
        } finally { account.close(); }
        while (true) {
          account = await core.openGatewayAccount(turn.accountId);
          try {
            if (signal?.aborted) { account.deviceRequests.cancel({...origin!,requestId:requestId!,correlationId:origin!.messageId}); throw new Error("TOOL_CANCELLED"); }
            const state = account.deviceRequests.get(requestId!);
            const receipt = account.store.database.prepare("SELECT claim_id FROM claim_receipts WHERE request_id=?").get(requestId!) as {claim_id:string} | undefined;
            if (receipt && ["succeeded","failed","denied","cancelled","outcome_unknown"].includes(state.state)) {
              const result = account.deviceRequests.readResult(requestId!,receipt.claim_id);
              const details = {requestId:requestId!,...(result ?? {outcome:"outcome_unknown"})};
              const response:ToolResult = {content:[{type:"text",text:JSON.stringify(details)}],details};
              if (result) adopted.set(callId,{accountId:turn.accountId,requestId:requestId!,claimId:receipt.claim_id,sessionKey:context.sessionKey!,hash:hash(response)});
              return response;
            }
            if (state.state === "expired" || state.state === "cancelled" || Date.parse(expiresAt!) <= Date.now()) {
              account.deviceRequests.recoverExpired();
              const details = {requestId:requestId!,outcome:"outcome_unknown",code:state.state === "expired" ? "DEVICE_OFFLINE" : "DEVICE_TIMEOUT"};
              return {content:[{type:"text",text:JSON.stringify(details)}],details};
            }
          } finally { account.close(); }
          await new Promise(resolve => setTimeout(resolve,200));
        }
      },
    };
  },{name:DEVICE_TOOL_NAME});
  api.on("after_tool_call",async (event,context) => {
    if (event.toolName !== DEVICE_TOOL_NAME || event.error) return;
    const callId = event.toolCallId ?? context.toolCallId;
    const pending = callId ? adopted.get(callId) : undefined;
    if (!pending || pending.sessionKey !== context.sessionKey || hash(event.result) !== pending.hash) return;
    const account = await core.openGatewayAccount(pending.accountId);
    try { account.deviceRequests.acknowledgeResult(pending.requestId,pending.claimId); adopted.delete(callId!); }
    finally { account.close(); }
  });
};
