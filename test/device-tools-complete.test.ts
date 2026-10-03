import {mkdtempSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {generateKeyPairSync} from "node:crypto";
import {expect,it} from "vitest";
import {gatewaySubschemaSha256} from "../../../gateway-contract/src/dispatched-schema-validator.js";
import {createGatewayCore,type VerifiedRequestContext} from "../src/core/gateway-core.js";
import {registerDeviceTools,trustedDeviceTurn,type DeviceToolApi,DEVICE_TOOL_NAME} from "../src/host/device-tools.js";

it("runs a trusted native tool through online TTL0 execution and ACKs only its adopted result",async()=> {
  const core=createGatewayCore({storageRoot:mkdtempSync(join(tmpdir(),"oai-tools-")),attachmentMasterKey:Buffer.alloc(32,5)});
  const a=await core.openGatewayAccount("acct_tools");
  a.credentials.setPassword("test-password");const key=generateKeyPairSync("ed25519").publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
  const session=a.sessions.createPasswordSession({username:"acct_tools",password:"test-password",installation:{installationId:"install_one",displayName:"phone",devicePublicKey:key},correlationId:"cor_login"});
  const ctx:VerifiedRequestContext={accountId:"acct_tools",deviceId:session.deviceId,sessionId:session.sessionId,requestId:"req_tools",correlationId:"cor_tools",pairingGeneration:1,grantRevision:1};
  const cid=a.conversations.create({clientConversationId:"cc_tools",correlationId:"cor_create"}).conversationId;
  a.conversations.bindHostSession(cid,{storePath:"/trusted/runtime/sessions.json",sessionKey:"native_one"});
  const schema={type:"object",additionalProperties:false,required:["limit"],properties:{limit:{type:"integer",minimum:1,maximum:2}}};
  const binding={pluginId:"org.example.actual",authorKeyId:`sha256:${"a".repeat(64)}`,capabilityId:"org.example.actual.read",capabilityVersion:"1.0.0",schemaSha256:gatewaySubschemaSha256(schema),schema,risk:"high-privilege-ephemeral" as const};
  expect(a.deviceRequests.capabilities.list(ctx.deviceId,1,1)).toEqual([]);
  a.deviceRequests.capabilities.register(ctx.deviceId,1,1,[binding]);
  expect(()=>a.deviceRequests.capabilities.register(ctx.deviceId,1,1,[{...binding,schemaSha256:`sha256:${"0".repeat(64)}`}])).toThrow("SCHEMA_INVALID");
  a.store.database.prepare("INSERT INTO account_metadata(key,value) VALUES (?,?)").run("message-device:msg_native",JSON.stringify({...ctx,conversationId:cid,messageId:"msg_native"}));
  a.close();core.setDeviceOnline!(ctx,true);
  let factory:Parameters<NonNullable<DeviceToolApi["registerTool"]>>[0]|undefined;
  let after:Parameters<NonNullable<DeviceToolApi["on"]>>[1]|undefined;
  registerDeviceTools({registerTool:f=>{factory=f;},on:(_,f)=>{after=f;}},core);
  expect(factory!({sessionKey:"native_one",messageChannel:"open-android-intelligence-gateway"})).toBeNull();
  await trustedDeviceTurn.run({accountId:"acct_tools",messageId:"msg_native"},async()=> {
    const tool=factory!({sessionKey:"native_one",messageChannel:"open-android-intelligence-gateway"})!;
    const pending=tool.execute("call_one",{capabilityId:binding.capabilityId,capabilityVersion:"1.0.0",parameters:{limit:1}});
    let requestId="",claimId="";
    for(let i=0;i<20;i++) {
      await new Promise(resolve=>setTimeout(resolve,20));const account=await core.openGatewayAccount(ctx.accountId);
      try {
        const row=account.store.database.prepare("SELECT request_id FROM device_requests").get() as {request_id:string}|undefined;
        if(row) {
          requestId=row.request_id;expect(account.deviceRequests.get(requestId).state).toBe("pending");
          const claim=account.deviceRequests.claim({...ctx,requestId,correlationId:"cor_claim"});claimId=claim.claimId;
          account.deviceRequests.submitResult({...ctx,requestId,claimId,result:{outcome:"succeeded",data:{records:["actual-device-result"]}},correlationId:"cor_result"});break;
        }
      }finally{account.close();}
    }
    expect(requestId).not.toBe("");const result=await pending;expect(result.details.data).toEqual({records:["actual-device-result"]});
    await after!({toolName:DEVICE_TOOL_NAME,toolCallId:"call_one",result:{...result,details:{...result.details,data:{records:["altered"]}}}},{sessionKey:"native_one"});
    let account=await core.openGatewayAccount(ctx.accountId);
    try{expect(account.deviceRequests.readResult(requestId,claimId)).toBeDefined();}finally{account.close();}
    await after!({toolName:DEVICE_TOOL_NAME,toolCallId:"call_one",result},{sessionKey:"native_one"});
    account=await core.openGatewayAccount(ctx.accountId);
    try {
      expect(account.deviceRequests.readResult(requestId,claimId)).toBeUndefined();
      expect(account.events.readAfter(null).filter(e=>e.eventType==="device.requested").every(e=>JSON.stringify(e.payload.parameters)==="{}")).toBe(true);
    }finally{account.close();}
  });
  const account=await core.openGatewayAccount(ctx.accountId);
  try {
    account.deviceRequests.enqueue({...ctx,requestId:"ephemeral_disconnect",risk:binding.risk,capability:{id:binding.capabilityId,version:"1.0.0"},provider:{pluginId:binding.pluginId,authorKeyId:binding.authorKeyId},parameters:{limit:1},online:true});
    core.setDeviceOnline!(ctx,true);core.setDeviceOnline!(ctx,false);
    expect(account.deviceRequests.get("ephemeral_disconnect").state).toBe("pending");
    core.setDeviceOnline!(ctx,false);
    expect(account.deviceRequests.get("ephemeral_disconnect").state).toBe("expired");
    expect(()=>account.deviceRequests.claim({...ctx,requestId:"ephemeral_disconnect"})).toThrow("OUTCOME_UNKNOWN");
    expect(core.isDeviceOnline!(ctx.accountId,ctx.deviceId,1)).toBe(false);
  }finally{account.close();}
});
