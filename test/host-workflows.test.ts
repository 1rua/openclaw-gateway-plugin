import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";
import { registerOpenAndroidIntelligenceGateway } from "../src/host/channel-adapter.js";
import { dispatchGatewayMessageToOpenClaw, OPENCLAW_CHANNEL_ID, type OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";

const context: VerifiedRequestContext = {accountId:"acct_host",deviceId:"dev_host",sessionId:"sess_host",requestId:"req_host",correlationId:"cor_host",pairingGeneration:1,grantRevision:1};
const createCore=()=>createGatewayCore({storageRoot:mkdtempSync(join(tmpdir(),"oai-host-workflows-")),attachmentMasterKey:Buffer.alloc(32,5)});
const native = await import("openclaw/plugin-sdk/channel-inbound") as unknown as {
  runChannelInboundEvent: OpenClawInboundRuntime["inbound"]["run"];
  buildChannelInboundEventContext: OpenClawInboundRuntime["inbound"]["buildContext"];
};
const runtime = (dispatch: (input:any)=>Promise<unknown>): OpenClawInboundRuntime => ({
  inbound:{run:native.runChannelInboundEvent,buildContext:native.buildChannelInboundEventContext},
  routing:{resolveAgentRoute:input=>resolveAgentRoute(input as Parameters<typeof resolveAgentRoute>[0])},
  session:{resolveStorePath:()=>"/tmp/openclaw-host-workflow/sessions.json",recordInboundSession:async()=>{}},
  reply:{dispatchReplyWithBufferedBlockDispatcher:dispatch},
});
const register=(core:ReturnType<typeof createCore>,channel:OpenClawInboundRuntime,request:(method:string,params?:Record<string,unknown>)=>Promise<unknown>)=>
  registerOpenAndroidIntelligenceGateway({gatewayCore:core,hostVersion:"2026.7.1",config:{},runtime:{channel,gateway:{request}},registerChannel:()=>{},registerHttpRoute:()=>{}});

describe("pinned OpenClaw host workflows",()=>{
  it("uses the real SDK to pass raw M4A audio and settle only after all assistant messages",async()=>{
    const core=createCore(); const account=await core.openGatewayAccount(context.accountId);
    try {
      const conv=account.conversations.create({clientConversationId:"cc_audio",correlationId:"cor_audio"});
      const bytes=Buffer.from("raw AAC MPEG-4 recording");
      const att=account.attachments.create({clientAttachmentId:"ca_audio",filename:"voice_42.m4a",mediaType:"audio/mp4",sizeBytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex"),correlationId:"cor_audio"});
      await account.attachments.uploadContent(att.attachmentId,bytes); account.attachments.commit(att.attachmentId);
      const accepted=account.conversations.acceptMessage({conversationId:conv.conversationId,clientMessageId:"cm_audio",text:"",attachmentIds:[att.attachmentId],deviceId:context.deviceId,requestId:context.requestId,correlationId:context.correlationId});
      let path="";
      const channel=runtime(async input=>{
        expect(input.ctx.MediaType).toBe("audio/mp4");
        path=input.ctx.MediaPath; expect(path.endsWith(".m4a")).toBe(true); expect(readFileSync(path)).toEqual(bytes);
        expect(input.replyOptions.runId).toBe(accepted.generationId);
        await input.replyOptions.onTurnAdopted();
        await input.dispatcherOptions.deliver({text:"First answer"},{kind:"block"});
        expect(account.conversations.workflow.current(conv.conversationId)?.state).toBe("running");
        await input.dispatcherOptions.deliver({text:"Second answer"},{kind:"final"});
        return {queuedFinal:true,counts:{tool:0,block:1,final:1}};
      });
      await dispatchGatewayMessageToOpenClaw({account,message:account.conversations.claimNextMessage()!,channelRuntime:channel,cfg:{},gatewayAccountId:context.accountId,channelAccountId:"default"});
      expect(account.conversations.workflow.current(conv.conversationId)).toBeNull();
      expect(account.conversations.getMessage(accepted.messageId).status).toBe("completed");
      expect(account.events.readAfter(null).filter(e=>e.eventType==="conversation.message.completed").map(e=>e.payload.generationId)).toEqual([accepted.generationId,accepted.generationId]);
      expect(existsSync(path)).toBe(false);
    } finally { account.close(); }
  });

  it("creates independent host sessions immediately, retries the same host key, and never sends /new",async()=>{
    const core=createCore(); const calls:Array<{method:string;params?:Record<string,unknown>}>=[]; let fail=true;
    register(core,runtime(async()=>({})),async(method,params)=>{
      calls.push({method,params});
      if(fail){fail=false;throw new Error("temporarily unavailable");}
      return {ok:true,key:params!.key};
    });
    const body={clientConversationId:"cc_one",title:"One"};
    const request={context,method:"POST" as const,target:"/open-android-intelligence/v2/conversations",idempotencyKey:context.requestId,body};
    expect((await core.handle(request)).error).toBeDefined();
    expect((await core.handle({...request,body:{...body,title:"Changed"}})).error?.code).toBe("IDEMPOTENCY_CONFLICT");
    const one=await core.handle(request); expect(one.error).toBeUndefined();
    expect(await core.handle(request)).toEqual(one);
    const two=await core.handle({...request,context:{...context,requestId:"req_two"},idempotencyKey:"req_two",body:{clientConversationId:"cc_two"}});
    expect(two.error).toBeUndefined(); expect(calls.map(c=>c.method)).toEqual(["sessions.create","sessions.create","sessions.create"]);
    expect(calls[0]!.params!.key).toBe(calls[1]!.params!.key);
    expect(calls[1]!.params!.key).not.toBe(calls[2]!.params!.key);
    expect(calls.every(c=>!("message" in c.params!) && !("task" in c.params!))).toBe(true);
    const account=await core.openGatewayAccount(context.accountId);
    expect(account.conversations.list()).toHaveLength(2); expect(account.conversations.claimNextMessage()).toBeUndefined(); account.close();
  });

  it("reads commands.list afresh including installed skills/plugins and changes the catalog version",async()=>{
    const core=createCore(); let commands=[{name:"status",description:"Host status",acceptsArgs:false}];
    register(core,runtime(async()=>({})),async(method,params)=>{
      expect(method).toBe("commands.list");expect(params).toEqual({agentId:"main",provider:OPENCLAW_CHANNEL_ID,scope:"text",includeArgs:true});return {commands};
    });
    const request={context,method:"GET" as const,target:"/open-android-intelligence/v2/commands?languageCode=zh-CN"};
    const first=await core.handle(request);
    expect(first.data).toMatchObject({languageCode:"zh-CN",commands:[{invocation:"/status",acceptsArguments:false,availability:"available"}]});
    commands=[...commands,{name:"my_skill",description:"Installed skill",acceptsArgs:true}];
    const second=await core.handle(request);
    expect(second.data!.commands).toHaveLength(2);expect(second.data!.catalogVersion).not.toBe(first.data!.catalogVersion);
  });

  it("aborts the exact native runner, waits for settle, and discards its late delivery",async()=>{
    const core=createCore(); const account=await core.openGatewayAccount(context.accountId);
    let start!:()=>void; const started=new Promise<void>(resolve=>{start=resolve;});
    const channel=runtime(async input=>{
      await input.replyOptions.onTurnAdopted(); start();
      await new Promise<void>(resolve=>input.replyOptions.abortSignal.addEventListener("abort",()=>resolve(),{once:true}));
      await input.dispatcherOptions.deliver({text:"Late text after abort"},{kind:"final"});
      return {queuedFinal:false,counts:{tool:0,block:0,final:0}};
    });
    register(core,channel,async()=>{throw new Error("must use the SDK AbortSignal for the tracked turn");});
    try {
      const conv=account.conversations.create({clientConversationId:"cc_cancel",correlationId:"cor_cancel"});
      const accepted=account.conversations.acceptMessage({conversationId:conv.conversationId,clientMessageId:"cm_cancel",text:"run",attachmentIds:[],deviceId:context.deviceId,requestId:context.requestId,correlationId:context.correlationId});
      const pending=dispatchGatewayMessageToOpenClaw({account,message:account.conversations.claimNextMessage()!,channelRuntime:channel,cfg:{},gatewayAccountId:context.accountId,channelAccountId:"default"});
      await started;
      const response=await core.handle({context,method:"POST",target:`/open-android-intelligence/v2/conversations/${conv.conversationId}/generations/${accepted.generationId}/cancel`,idempotencyKey:context.requestId,body:{requestId:context.requestId}});
      await pending;
      expect(response.data).toEqual({outcome:"CANCELLED",generationId:accepted.generationId});
      expect(account.conversations.workflow.current(conv.conversationId)).toBeNull();
      expect(account.events.readAfter(null).filter(e=>e.eventType==="conversation.message.completed")).toHaveLength(0);
      expect(account.events.readAfter(null).at(-1)?.eventType).toBe("conversation.generation.cancelled");
    } finally {account.close();}
  });
  it("uses a run-scoped native abort receipt for recovered turns",async()=>{
    const core=createCore();const account=await core.openGatewayAccount(context.accountId);
    const calls:Array<{method:string;params?:Record<string,unknown>}>=[];
    register(core,runtime(async()=>({})),async(method,params)=>{calls.push({method,params});return {ok:true,aborted:true};});
    try {
      const conv=account.conversations.create({clientConversationId:"cc_recovered",correlationId:"cor_recovered"});
      const accepted=account.conversations.acceptMessage({conversationId:conv.conversationId,clientMessageId:"cm_recovered",text:"run",attachmentIds:[],deviceId:context.deviceId,requestId:context.requestId,correlationId:context.correlationId});
      account.conversations.claimNextMessage();
      account.conversations.bindHostSession(conv.conversationId,{storePath:"/sessions.json",sessionKey:"agent:main:recovered"});
      const response=await core.handle({context,method:"POST",target:`/open-android-intelligence/v2/conversations/${conv.conversationId}/generations/${accepted.generationId}/cancel`,idempotencyKey:context.requestId,body:{requestId:context.requestId}});
      expect(response.data).toEqual({outcome:"CANCELLED",generationId:accepted.generationId});
      expect(calls).toEqual([{method:"chat.abort",params:{sessionKey:"agent:main:recovered",runId:accepted.generationId}}]);
    } finally {account.close();}
  });

  it("creates sessions using the active nondefault channel account and its configured agent binding",async()=>{
    const core=createCore();const channelRuntime=runtime(async()=>({}));
    let channel:any;let params:Record<string,unknown>|undefined;
    registerOpenAndroidIntelligenceGateway({gatewayCore:core,hostVersion:"2026.7.1",config:{},
      runtime:{channel:channelRuntime,gateway:{request:async(_method,input)=>{params=input;return {ok:true,key:input!.key};}}},
      registerChannel:value=>{channel="plugin" in value ? value.plugin : value;},registerHttpRoute:()=>{}});
    const controller=new AbortController();controller.abort();
    await channel.gateway.startAccount({accountId:"secondary",abortSignal:controller.signal,channelRuntime,
      cfg:{agents:{list:[{id:"main",default:true},{id:"alternate"}]},bindings:[{agentId:"alternate",match:{channel:"open-android-intelligence-gateway",accountId:"secondary"}}]}});
    const response=await core.handle({context,method:"POST",target:"/open-android-intelligence/v2/conversations",idempotencyKey:context.requestId,body:{clientConversationId:"cc_secondary"}});
    expect(response.error).toBeUndefined();expect(params!.agentId).toBe("alternate");
    expect(params!.key).toMatch(/^agent:alternate:open-android-intelligence-gateway:secondary:direct:/u);
  });

});
