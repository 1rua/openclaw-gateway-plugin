import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { setRuntimeConfigSnapshot, clearRuntimeConfigSnapshot } from "openclaw/plugin-sdk/config-runtime";
import { coreSchemaHash } from "../gateway-contract/src/core-schema-hash.js";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";
import { registerOpenAndroidIntelligenceGateway as registerSource } from "../src/host/channel-adapter.js";
import type { OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";

// Tests load the exact pinned host; production dispatches its public gateway API.
const dist=resolve(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/routing")),"..");
const loadNative=(file:string):Promise<Record<string,any>>=>import(pathToFileURL(join(dist,file)).href);
const {sessionsHandlers}=await loadNative("sessions-UcKjjh_n.js");
const {n:createGatewaySession}=await loadNative("session-create-service-14oZxrT5.js");
const registerRuntime=(await import(new URL("../runtime/src/host/channel-adapter.js",import.meta.url).href)).registerOpenAndroidIntelligenceGateway as typeof registerSource;
const createRuntimeCore=(await import(new URL("../runtime/src/core/gateway-core.js",import.meta.url).href)).createGatewayCore as typeof createGatewayCore;
const context:VerifiedRequestContext={accountId:"acct_management",deviceId:"dev_one",sessionId:"sess_one",requestId:"req_one",
  correlationId:"cor_management",pairingGeneration:1,grantRevision:1};
const prefix="/open-android-intelligence/v2";
afterEach(()=>clearRuntimeConfigSnapshot());

const setup=(register=registerSource,createCore=createGatewayCore,existingRoot?:string)=> {
  const root=existingRoot ?? mkdtempSync(join(tmpdir(),"oai-native-management-")),storePath=join(root,"sessions.json");
  const cfg={session:{store:storePath}};
  const core=createCore({storageRoot:join(root,"gateway"),attachmentMasterKey:Buffer.alloc(32,9)});
  const runtime:OpenClawInboundRuntime={inbound:{run:async()=>({}),buildContext:input=>input},
    routing:{resolveAgentRoute:input=>resolveAgentRoute(input as Parameters<typeof resolveAgentRoute>[0])},
    session:{resolveStorePath:()=>storePath,recordInboundSession:async()=>{}},reply:{dispatchReplyWithBufferedBlockDispatcher:async()=>({})}};
  const calls:Array<{method:string;params?:Record<string,unknown>}>=[];
  const nativeContext={getRuntimeConfig:()=>cfg,loadGatewayModelCatalog:async()=>[],broadcast:()=>{},
    chatAbortControllers:new Map(),chatRunBuffers:new Map(),agentRunSeq:new Map(),dedupe:new Map()};
  const nativeRequest=async(method:string,params?:Record<string,unknown>)=> {
    setRuntimeConfigSnapshot(cfg);
    if(method==="sessions.create") return createGatewaySession({cfg,...params});
    return new Promise((done,fail)=> {
      Promise.resolve(sessionsHandlers[method]({params,context:nativeContext,
        respond:(ok:boolean,payload:unknown,error:unknown)=>ok?done(payload):fail(error)})).catch(fail);
    });
  };
  register({gatewayCore:core,hostVersion:"2026.7.1",config:cfg,runtime:{channel:runtime,gateway:{request:async(method,params)=>{
    calls.push({method,params});return nativeRequest(method,params);
  }}},registerChannel:()=>{},registerHttpRoute:()=>{}});
  const request=(method:"GET"|"PUT"|"POST"|"DELETE"|"PATCH",path:string,body?:unknown,id="req_one",device="dev_one",account="acct_management")=>
    core.handle({context:{...context,requestId:id,deviceId:device,accountId:account},method,target:prefix+path,idempotencyKey:id,...(body!==undefined?{body}:{})});
  const create=async(clientId:string,id:string)=> {
    const result=await request("POST","/conversations",{clientConversationId:clientId,title:"Same title"},id);
    expect(result.error).toBeUndefined();return (result.data!.conversation as {conversationId:string}).conversationId;
  };
  const nativeStore=()=>JSON.parse(readFileSync(storePath,"utf8")) as Record<string,Record<string,unknown>>;
  return {core,calls,create,request,nativeStore,nativeRequest,storePath,root};
};

describe.each([{flavor:"source",register:registerSource,createCore:createGatewayCore},{flavor:"runtime",register:registerRuntime,createCore:createRuntimeCore}])("$flavor native conversation management",({register,createCore})=> {
  it("negotiates management only when offered and connected to the native lifecycle API",async()=> {
    const {core,root}=setup(register,createCore);
    const bare=createCore({storageRoot:join(root,"without-native-api"),attachmentMasterKey:Buffer.alloc(32,9)});
    const negotiate=(gateway:typeof core,offered:string[])=>gateway.handle({method:"POST",target:prefix+"/negotiate",body:{
      negotiationId:"neg_management",protocol:{major:2,minor:1},
      client:{installationId:"install_management",appVersion:"2.1.0",platform:"android",platformApi:35},
      features:{auth:["password"],messages:["chat-v1"],attachments:["staged-sha256-v1"],events:["sse-cursor-v1"],
        deviceRequests:["risk-queue-v1"],conversationUi:offered},schemaHashes:{core:coreSchemaHash()},
    }});
    expect((await negotiate(bare,["conversation-management-v1"])).data?.features).not.toHaveProperty("conversationUi");
    expect((await negotiate(core,["conversation-management-v1"])).data?.features).toMatchObject({conversationUi:["conversation-management-v1"]});
    const noOffer=createCore({storageRoot:join(root,"without-management-offer"),attachmentMasterKey:Buffer.alloc(32,9)});
    noOffer.setHostConversationManager!(async()=>{});
    expect((await negotiate(noOffer,[])).data?.features).not.toHaveProperty("conversationUi");
  });

  it("archives/restores/deletes the real host store and preserves another account's native session",async()=> {
    const {core,calls,create,request,nativeStore}=setup(register,createCore);
    const cid=await create("cc_one","req_create_one"),other=await create("cc_other","req_create_other");
    const account=await core.openGatewayAccount(context.accountId);
    const binding=account.conversations.workflow.get<{sessionKey:string}>(`host-session:${cid}`)!;
    const otherBinding=account.conversations.workflow.get<{sessionKey:string}>(`host-session:${other}`)!;
    account.close();
    const initial=nativeStore()[binding.sessionKey]!;
    expect((await request("PATCH",`/conversations/${cid}`,{archived:true},"req_archive")).data).toMatchObject({conversation:{archived:true}});
    expect(nativeStore()[binding.sessionKey]!.archivedAt).toBeTypeOf("number");
    expect((await request("GET","/conversations")).data!.conversations).toEqual(expect.arrayContaining([expect.objectContaining({conversationId:cid,archived:true})]));
    expect((await request("PATCH",`/conversations/${cid}`,{archived:false},"req_restore")).error).toBeUndefined();
    expect(nativeStore()[binding.sessionKey]!.archivedAt).toBeUndefined();
    const deleted=await request("DELETE",`/conversations/${cid}`,undefined,"req_delete");
    expect(deleted.error).toBeUndefined();expect(deleted.data).toEqual({conversationId:cid,deleted:true});
    expect(nativeStore()[binding.sessionKey]).toBeUndefined();expect(nativeStore()[otherBinding.sessionKey]).toBeDefined();
    expect(await request("DELETE",`/conversations/${cid}`,undefined,"req_delete")).toEqual(deleted);
    const deletion=calls.find(call=>call.method==="sessions.delete")!;
    expect(deletion.params).toMatchObject({key:binding.sessionKey,deleteTranscript:true,expectedSessionId:initial.sessionId});
    expect((await request("GET",`/conversations/${cid}/messages`)).error?.code).toBe("CONVERSATION_NOT_FOUND");
    const reopened=await core.openGatewayAccount(context.accountId);
    try {expect(()=>reopened.conversations.create({clientConversationId:"cc_one",title:"Same title",correlationId:"cor_retry"})).toThrow("CONVERSATION_NOT_FOUND");}
    finally {reopened.close();}
  });

  it("shares folders and custom order across devices with optimistic conflicts and account isolation",async()=> {
    const {create,request}=setup(register,createCore);const cid=await create("cc_one","req_create");
    const first=(await request("GET","/conversations?limit=1")).data!;
    const body={expectedRevision:0,sortMode:"custom",customOrder:[cid],folders:[{folderId:"folder_work",name:"Work"}],assignments:{[cid]:"folder_work"}};
    const saved=(await request("PUT","/conversation-organization",body,"req_organize")).data!;
    expect(saved.revision).toBe(1);
    expect((await request("GET","/conversation-organization",undefined,"req_get","dev_two")).data).toEqual(saved);
    expect((await request("PUT","/conversation-organization",body,"req_stale","dev_two")).error?.code).toBe("ORGANIZATION_CONFLICT");
    expect((await request("GET","/conversations?limit=1")).data!.snapshotRevision).toBe(first.snapshotRevision);
    expect((await request("GET","/conversation-organization",undefined,"req_other","dev_two","acct_other")).data!.folders).toEqual([]);
    expect((await request("PUT","/conversation-organization",{...body,expectedRevision:1,assignments:{conv_foreign:"folder_work"}},"req_foreign")).error?.code).toBe("SCHEMA_INVALID");
    expect((await request("DELETE",`/conversations/${cid}`,undefined,"req_delete")).error).toBeUndefined();
    expect((await request("GET","/conversation-organization")).data).toMatchObject({revision:2,customOrder:[],assignments:{}});
  });

  it("refuses queued work before native deletion and projects external native archive/deletion",async()=> {
    const {core,calls,create,request,nativeStore,nativeRequest}=setup(register,createCore);
    const cid=await create("cc_busy","req_create");const account=await core.openGatewayAccount(context.accountId);
    let sessionKey:string;
    try {
      sessionKey=account.conversations.workflow.get<{sessionKey:string}>(`host-session:${cid}`)!.sessionKey;
      account.conversations.acceptMessage({conversationId:cid,clientMessageId:"cm_busy",text:"Queued",attachmentIds:[],deviceId:"dev_one",requestId:"req_queued",correlationId:"cor_queued"});
    } finally {account.close();}
    expect((await request("DELETE",`/conversations/${cid}`,undefined,"req_busy")).error?.code).toBe("CONVERSATION_BUSY");
    expect(calls.some(call=>call.method==="sessions.delete")).toBe(false);expect(nativeStore()[sessionKey]).toBeDefined();
    const external=await create("cc_external","req_external");const lookup=await core.openGatewayAccount(context.accountId);
    const binding=lookup.conversations.workflow.get<{sessionKey:string}>(`host-session:${external}`)!;lookup.close();
    await nativeRequest("sessions.patch",{key:binding.sessionKey,archived:true});
    expect((await request("GET","/conversations")).data!.conversations).toEqual(expect.arrayContaining([expect.objectContaining({conversationId:external,archived:true})]));
    await nativeRequest("sessions.delete",{key:binding.sessionKey,deleteTranscript:true});
    expect((await request("GET","/conversations")).data!.conversations).not.toEqual(expect.arrayContaining([expect.objectContaining({conversationId:external})]));
  });

  it("migrates native materialization evidence before the first upgraded list and keeps untouched legacy bindings",async()=> {
    const {core,request,nativeStore,nativeRequest,storePath}=setup(register,createCore);
    const account=await core.openGatewayAccount(context.accountId);
    const deleted:Array<{id:string;clientId:string;sessionKey:string}>=[];
    let untouched:string,failedBeforeAdoption:string;
    try {
      for(const evidence of ["completed","adopted-failure","native-history","checkpoint"] as const) {
        const clientId=`cc_legacy_${evidence}`;
        const id=account.conversations.create({clientConversationId:clientId,correlationId:"cor_legacy"}).conversationId;
        const accepted=evidence==="completed" || evidence==="adopted-failure" ? account.conversations.acceptMessage({conversationId:id,clientMessageId:`cm_${evidence}`,text:"Legacy send",attachmentIds:[],deviceId:"dev_one",requestId:`req_${evidence}`,correlationId:"cor_legacy"}) : undefined;
        const sessionKey=`agent:main:legacy_${evidence}`;
        await nativeRequest("sessions.create",{key:sessionKey});
        // Seed the old binding format, before route observations existed.
        account.conversations.workflow.put(`host-session:${id}`,{sessionKey,storePath});
        if(accepted) {
          account.conversations.markDelivered(accepted.messageId,"cor_legacy");
          if(evidence==="completed") {
            account.conversations.markCompleted(accepted.messageId,"cor_legacy");
            account.store.database.prepare("UPDATE messages SET delivered_at=NULL WHERE message_id=?").run(accepted.messageId);
          }
          else account.conversations.markFailed(accepted.messageId,"MODEL_REQUEST_REJECTED","cor_legacy");
          account.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(`native-checkpoint:${id}`);
        } else {
          const sessionId=String(nativeStore()[sessionKey]!.sessionId);
          writeFileSync(join(dirname(storePath),`${sessionId}.jsonl`),JSON.stringify({type:"message",id:"legacy_native_reply",timestamp:new Date().toISOString(),message:{role:"assistant",content:"Legacy reply"}})+"\n");
          if(evidence==="native-history") await account.conversations.listMessages(id);
          else account.conversations.checkpointHostHistory(id);
        }
        account.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(`conversation-native-seen:${id}`);
        expect(account.store.database.prepare("SELECT 1 FROM account_metadata WHERE key=?").get(`conversation-native-seen:${id}`)).toBeUndefined();
        deleted.push({id,clientId,sessionKey});
      }
      untouched=account.conversations.create({clientConversationId:"cc_untouched",correlationId:"cor_legacy"}).conversationId;
      account.conversations.bindHostSession(untouched,{sessionKey:"agent:main:never_materialized",storePath});
      failedBeforeAdoption=account.conversations.create({clientConversationId:"cc_failed_before_adoption",correlationId:"cor_legacy"}).conversationId;
      const queued=account.conversations.acceptMessage({conversationId:failedBeforeAdoption,clientMessageId:"cm_never_adopted",text:"Never adopted",attachmentIds:[],deviceId:"dev_one",requestId:"req_never_adopted",correlationId:"cor_legacy"});
      account.conversations.markFailed(queued.messageId,"MODEL_REQUEST_REJECTED","cor_legacy");
      account.conversations.bindHostSession(failedBeforeAdoption,{sessionKey:"agent:main:failed_before_native_admission",storePath});
      // Evidence must match this conversation exactly, including literal underscores.
      account.conversations.workflow.put(`history-native:${untouched.replace("_","X")}:unrelated`,"msg_unrelated");
      account.conversations.workflow.put(`native-checkpoint:${untouched}`,{storePath,sessionKey:"agent:main:another_route",watermark:{sessionId:"unrelated",fileId:"1:2",byteLength:1}});
      account.conversations.management.replace({expectedRevision:0,sortMode:"custom",customOrder:deleted.map(row=>row.id),folders:[{folderId:"legacy",name:"Legacy"}],assignments:Object.fromEntries(deleted.map(row=>[row.id,"legacy"]))},"cor_legacy");
    } finally {account.close();}
    for(const row of deleted) await nativeRequest("sessions.delete",{key:row.sessionKey,deleteTranscript:true});
    const list=(await request("GET","/conversations")).data!.conversations as Array<{conversationId:string}>;
    expect(new Set(list.map(row=>row.conversationId))).toEqual(new Set([untouched!,failedBeforeAdoption!]));
    const reopened=await core.openGatewayAccount(context.accountId);
    try {
      expect(reopened.conversations.management.organization()).toMatchObject({customOrder:[],assignments:{}});
      for(const row of deleted) {
        expect(reopened.conversations.management.state(row.id).deleted).toBe(true);
        expect(()=>reopened.conversations.create({clientConversationId:row.clientId,correlationId:"cor_retry"})).toThrow("CONVERSATION_NOT_FOUND");
      }
    } finally {reopened.close();}
    // Another account's materialized receipt cannot delete an untouched binding.
    const other=await core.openGatewayAccount("acct_other");
    try {other.conversations.workflow.put(`history-native:${untouched!}:foreign`,"msg_foreign");} finally {other.close();}
    for(const row of deleted) await nativeRequest("sessions.create",{key:row.sessionKey});
    expect((await request("GET","/conversations")).data!.conversations).toHaveLength(2);
    for(const row of deleted) expect((await request("GET",`/conversations/${row.id}/messages`)).error?.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it("remembers successful native creation when an empty session is deleted before its first list",async()=> {
    const {core,create,request,nativeRequest}=setup(register,createCore);
    const id=await create("cc_empty_native","req_create_empty");
    const account=await core.openGatewayAccount(context.accountId);
    let sessionKey:string;
    try {sessionKey=account.conversations.workflow.get<{sessionKey:string}>(`host-session:${id}`)!.sessionKey;}
    finally {account.close();}
    await nativeRequest("sessions.delete",{key:sessionKey,deleteTranscript:true});
    expect((await request("GET","/conversations")).data!.conversations).toEqual([]);
    expect((await request("GET",`/conversations/${id}/messages`)).error?.code).toBe("CONVERSATION_NOT_FOUND");
  });

  it.each(["legacy-receipt","observed-native"] as const)("isolates %s evidence when a trusted binding changes before native materialization",async evidence=> {
    const {core,nativeRequest,storePath}=setup(register,createCore);
    const account=await core.openGatewayAccount(context.accountId);
    let id:string;
    try {
      id=account.conversations.create({clientConversationId:`cc_rebound_${evidence}`,correlationId:"cor_rebound"}).conversationId;
      const accepted=account.conversations.acceptMessage({conversationId:id,clientMessageId:"cm_old_binding",text:"Old route",attachmentIds:[],deviceId:"dev_one",requestId:"req_old_binding",correlationId:"cor_rebound"});
      const oldBinding={storePath,sessionKey:`agent:main:old_${evidence}`};
      await nativeRequest("sessions.create",{key:oldBinding.sessionKey});
      account.conversations.workflow.put(`host-session:${id}`,oldBinding);
      account.conversations.markDelivered(accepted.messageId,"cor_rebound");
      account.conversations.markCompleted(accepted.messageId,"cor_rebound");
      if(evidence==="legacy-receipt") account.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(`conversation-native-seen:${id}`);
      else account.conversations.management.record(id);
      const rebound={storePath,sessionKey:`agent:main:new_${evidence}`};
      account.conversations.bindHostSession(id,rebound);
      expect(account.conversations.management.record(id)).toMatchObject({conversationId:id});
      expect(()=>account.conversations.management.requireWritable(id)).not.toThrow();
    } finally {account.close();}
    const reopened=await core.openGatewayAccount(context.accountId);
    try {
      expect(reopened.conversations.management.record(id!)).toMatchObject({conversationId:id!});
      const binding=reopened.conversations.workflow.get<{sessionKey:string}>(`host-session:${id!}`)!;
      await nativeRequest("sessions.create",{key:binding.sessionKey});
      reopened.conversations.checkpointHostHistory(id!);
      await nativeRequest("sessions.delete",{key:binding.sessionKey,deleteTranscript:true});
      expect(()=>reopened.conversations.management.record(id!)).toThrow("CONVERSATION_NOT_FOUND");
      expect(()=>reopened.conversations.bindHostSession(id!,{storePath,sessionKey:"agent:main:cannot_revive"})).toThrow("CONVERSATION_NOT_FOUND");
      expect(reopened.conversations.management.state(id!).deleted).toBe(true);
    } finally {reopened.close();}
  });

  it.each(["archive","delete"] as const)("recovers native %s after receipt persistence fails and the gateway restarts",async operation=> {
    const initial=setup(register,createCore);
    const id=await initial.create(`cc_receipt_loss_${operation}`,"req_create");
    const account=await initial.core.openGatewayAccount(context.accountId);
    let sessionKey:string;
    try {
      sessionKey=account.conversations.workflow.get<{sessionKey:string}>(`host-session:${id}`)!.sessionKey;
      account.store.database.exec("CREATE TRIGGER fail_management_receipt BEFORE INSERT ON idempotency_ledger WHEN NEW.request_id='req_receipt_loss' BEGIN SELECT RAISE(ABORT,'injected receipt persistence failure'); END");
    } finally {account.close();}
    const method=operation==="delete" ? "DELETE" : "PATCH",body=operation==="archive" ? {archived:true} : undefined;
    const lost=await initial.request(method,`/conversations/${id}`,body,"req_receipt_loss");
    expect(lost.error?.code).toBe("OUTCOME_UNKNOWN");
    const nativeAfterMutation=initial.nativeStore();
    if(operation==="delete") expect(nativeAfterMutation[sessionKey!]).toBeUndefined();
    else expect(nativeAfterMutation[sessionKey!]!.archivedAt).toBeTypeOf("number");
    const persisted=await initial.core.openGatewayAccount(context.accountId);
    try {
      expect(persisted.conversations.management.state(id)).toMatchObject({pending:true,pendingRequestId:"dev_one:req_receipt_loss"});
      expect(()=>persisted.conversations.bindHostSession(id,{storePath:initial.storePath,sessionKey:"agent:main:cannot_clear_pending"})).toThrow("CONVERSATION_BUSY");
      expect(persisted.store.database.prepare("SELECT 1 FROM idempotency_ledger WHERE request_id='req_receipt_loss'").get()).toBeUndefined();
      persisted.store.database.exec("DROP TRIGGER fail_management_receipt");
    } finally {persisted.close();}
    const restarted=setup(register,createCore,initial.root);
    expect((await restarted.request(method,`/conversations/${id}`,body,"req_new_key")).error?.code).toBe("OUTCOME_UNKNOWN");
    expect((await restarted.request(method,`/conversations/${id}`,body,"req_receipt_loss","dev_two")).error?.code).toBe("OUTCOME_UNKNOWN");
    expect((await restarted.request("PATCH",`/conversations/${id}`,{archived:operation!=="archive"},"req_receipt_loss")).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const recovered=await restarted.request(method,`/conversations/${id}`,body,"req_receipt_loss");
    expect(recovered.error).toBeUndefined();
    expect(recovered.data).toMatchObject(operation==="delete" ? {conversationId:id,deleted:true} : {conversation:{conversationId:id,archived:true}});
    expect(restarted.nativeStore()).toEqual(nativeAfterMutation);
    expect(restarted.calls.filter(call=>call.method==="sessions.patch" || call.method==="sessions.delete")).toHaveLength(0);
    expect(await restarted.request(method,`/conversations/${id}`,body,"req_receipt_loss")).toEqual(recovered);
    const settled=await restarted.core.openGatewayAccount(context.accountId);
    try {
      expect(settled.conversations.management.state(id).pending).toBeUndefined();
      expect(settled.events.readAfter(null).filter(event=>event.eventType==="conversation.updated" && event.payload.conversationId===id)).toHaveLength(1);
    } finally {settled.close();}
  });
});

it("pages every historical thread including archives and invalidates cursors after native state changes",async()=> {
  const {core,request,storePath}=setup();const account=await core.openGatewayAccount(context.accountId);
  const native:Record<string,Record<string,unknown>>={};const ids:string[]=[];
  try {
    for(let i=0;i<121;i++) {
      const cid=account.conversations.create({clientConversationId:`cc_${i}`,correlationId:"cor_seed",now:new Date(1000+i)}).conversationId;
      const sessionKey=`trusted_${i}`;ids.push(cid);native[sessionKey]={sessionId:`native_${i}`,updatedAt:2000+i,...(i%2===0?{archivedAt:3000}:{})};
      account.conversations.bindHostSession(cid,{sessionKey,storePath});
    }
  } finally {account.close();}
  writeFileSync(storePath,JSON.stringify(native));
  const seen=new Set<string>(),revisions=new Set<number>();let cursor:string|undefined;
  do {
    const data=(await request("GET","/conversations?"+new URLSearchParams({limit:"17",...(cursor?{cursor}:{})}))).data!;
    for(const row of data.conversations as Array<{conversationId:string}>) seen.add(row.conversationId);
    revisions.add(data.snapshotRevision as number);cursor=data.nextCursor as string|undefined;
  } while(cursor);
  expect(seen.size).toBe(121);expect(revisions.size).toBe(1);
  const first=(await request("GET","/conversations?limit=1")).data!;
  native.trusted_0!.updatedAt=5000;writeFileSync(storePath,JSON.stringify(native));
  expect((await request("GET","/conversations?"+new URLSearchParams({cursor:String(first.nextCursor)}))).error?.code).toBe("CURSOR_EXPIRED");
  expect((await request("GET","/conversations?limit=0")).error?.code).toBe("SCHEMA_INVALID");
});

it("reserves device/request identity before a native await and fences unknown outcomes across other routes",async()=> {
  const {core,create,request}=setup();
  const first=await create("cc_one","req_create_one"),second=await create("cc_two","req_create_two");
  let calls=0;
  core.setHostConversationManager!(async()=>{calls++;throw new Error("response lost");});
  expect((await request("DELETE",`/conversations/${first}`,undefined,"req_unknown")).error?.code).toBe("OUTCOME_UNKNOWN");
  expect((await request("DELETE",`/conversations/${second}`,undefined,"req_unknown")).error?.code).toBe("IDEMPOTENCY_CONFLICT");
  expect((await request("DELETE",`/conversations/${first}`,undefined,"req_unknown","dev_two")).error?.code).toBe("OUTCOME_UNKNOWN");
  expect((await request("PUT","/conversation-organization",{expectedRevision:0,sortMode:"custom",customOrder:[],folders:[],assignments:{}},"req_unknown")).error?.code).toBe("IDEMPOTENCY_CONFLICT");
  expect(calls).toBe(1);
  core.setHostConversationManager!(async()=>{calls++;});
  expect((await request("DELETE",`/conversations/${first}`,undefined,"req_unknown")).data).toEqual({conversationId:first,deleted:true});
  expect(calls).toBe(2);
});
