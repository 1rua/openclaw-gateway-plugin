import { basename, dirname, join } from "node:path";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";
import { dispatchGatewayMessageToOpenClaw, OPENCLAW_CHANNEL_ID, type OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";
import { registerOpenAndroidIntelligenceGateway } from "../src/host/channel-adapter.js";

const native=await import("openclaw/plugin-sdk/channel-inbound") as unknown as {
  runChannelInboundEvent:OpenClawInboundRuntime["inbound"]["run"];
  buildChannelInboundEventContext:OpenClawInboundRuntime["inbound"]["buildContext"];
};
type Implementation={createCore:typeof createGatewayCore;dispatch:typeof dispatchGatewayMessageToOpenClaw;register:typeof registerOpenAndroidIntelligenceGateway};
const runtimeCore=await import(new URL("../runtime/src/core/gateway-core.js",import.meta.url).href);
const runtimeDispatch=await import(new URL("../runtime/src/host/inbound-dispatch.js",import.meta.url).href);
const runtimeRegister=await import(new URL("../runtime/src/host/channel-adapter.js",import.meta.url).href);
const implementations:Array<Implementation & {flavor:string}>=[
  {flavor:"source",createCore:createGatewayCore,dispatch:dispatchGatewayMessageToOpenClaw,register:registerOpenAndroidIntelligenceGateway},
  {flavor:"runtime",createCore:runtimeCore.createGatewayCore,dispatch:runtimeDispatch.dispatchGatewayMessageToOpenClaw,register:runtimeRegister.registerOpenAndroidIntelligenceGateway},
];
const ctx:VerifiedRequestContext={accountId:"acct_boundary",deviceId:"dev_boundary",sessionId:"sess_boundary",requestId:"req_cancel",correlationId:"cor_real_http_cancel",pairingGeneration:1,grantRevision:1};
const assistant=(text:string):any=>({role:"assistant",content:[{type:"text",text}],api:"openai-responses",provider:"openai",model:"test",usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:"stop",timestamp:Date.now()});
const user=(text:string):any=>({role:"user",content:text,timestamp:Date.now()});
const setup=async(impl:Implementation)=>{
  const root=mkdtempSync(join(tmpdir(),"oai-turn-boundary-"));
  const core=impl.createCore({storageRoot:join(root,"gateway"),attachmentMasterKey:Buffer.alloc(32,8)});
  let account=await core.openGatewayAccount(ctx.accountId);
  const cid=account.conversations.create({clientConversationId:"cc_boundary",correlationId:"cor_create"}).conversationId;
  const storePath=join(root,"sessions.json");const sessionKey=`agent:main:${OPENCLAW_CHANNEL_ID}:default:direct:boundary`;
  const manager=SessionManager.create(root,root);
  manager.appendMessage(user("Old user"));manager.appendMessage(assistant("same text"));
  const bind=()=>writeFileSync(storePath,JSON.stringify({[sessionKey]:{sessionId:manager.getSessionId(),sessionFile:basename(manager.getSessionFile()!)}}));bind();
  account.conversations.bindHostSession(cid,{storePath,sessionKey});
  const routes:any[]=[];
  const runtime=(dispatch:(input:any)=>Promise<unknown>):OpenClawInboundRuntime=>({
    inbound:{buildContext:native.buildChannelInboundEventContext,run:async params=>{
      const input=params as any;return native.runChannelInboundEvent({...input,adapter:{...input.adapter,resolveTurn:async(...args:any[])=>{
        const turn=await input.adapter.resolveTurn(...args);routes.push({agentId:turn.agentId,accountId:turn.accountId,sessionKey:turn.routeSessionKey,storePath:turn.storePath});return turn;
      }}});
    }},routing:{resolveAgentRoute:input=>resolveAgentRoute(input as Parameters<typeof resolveAgentRoute>[0])},
    session:{resolveStorePath:(_store,options)=>join(root,`${(options as {agentId:string}).agentId}-sessions.json`),recordInboundSession:async()=>{}},
    reply:{dispatchReplyWithBufferedBlockDispatcher:dispatch},
  });
  const register=(channel:OpenClawInboundRuntime,request:(_method:string,_params?:Record<string,unknown>)=>Promise<unknown>=async()=>{throw new Error("unexpected native RPC");})=>impl.register({gatewayCore:core,hostVersion:"2026.7.1",config:{},runtime:{channel,gateway:{request}},registerChannel:()=>{},registerHttpRoute:()=>{}});
  let number=0;
  const accept=(text:string)=>account.conversations.acceptMessage({conversationId:cid,clientMessageId:`cm_${++number}`,text,attachmentIds:[],deviceId:ctx.deviceId,requestId:`req_message_${number}`,correlationId:"cor_message"});
  const dispatch=(channel:OpenClawInboundRuntime,cfg:unknown={},channelAccountId="default")=>impl.dispatch({account,message:account.conversations.claimNextMessage()!,channelRuntime:channel,cfg,gatewayAccountId:ctx.accountId,channelAccountId});
  return {core,cid,manager,storePath,sessionKey,routes,runtime,register,accept,dispatch,get account(){return account;},reopen:async()=>{account.close();account=await core.openGatewayAccount(ctx.accountId);},close:()=>account.close()};
};
const cancelScenario=async(impl:Implementation)=>{
  const fixture=await setup(impl);
  let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
  const channel=fixture.runtime(async input=>{
    fixture.manager.appendMessage(user("Cancelled user"));await input.replyOptions.onTurnAdopted();
    fixture.manager.appendMessage(assistant("Keep before cancel"));await input.dispatcherOptions.deliver({text:"Keep before cancel"},{kind:"block"});start();
    await new Promise<void>(resolve=>input.replyOptions.abortSignal.addEventListener("abort",()=>resolve(),{once:true}));
    fixture.manager.appendMessage(assistant("same text"));await input.dispatcherOptions.deliver({text:"same text"},{kind:"final"});
    return {queuedFinal:false,counts:{tool:0,block:1,final:0}};
  });
  fixture.register(channel);const accepted=fixture.accept("Cancelled user");const pending=fixture.dispatch(channel);await started;
  const request={context:ctx,method:"POST" as const,target:`/open-android-intelligence/v2/conversations/${fixture.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:ctx.requestId,body:{requestId:ctx.requestId}};
  const response=await fixture.core.handle(request);await pending;expect(response.data).toMatchObject({outcome:"CANCELLED"});
  return {...fixture,fixture,request};
};

describe.each(implementations)("$flavor persisted native turn boundaries",impl=>{
  it("keeps a stored session's agent/account/key/store coherent after route configuration changes",async()=>{
    const f=await setup(impl);
    try {
      const key=`agent:original:${OPENCLAW_CHANNEL_ID}:secondary:direct:old`;
      f.account.conversations.bindHostSession(f.cid,{storePath:f.storePath,sessionKey:key});
      const channel=f.runtime(async input=>{await input.replyOptions.onTurnAdopted();return {queuedFinal:false,counts:{tool:0,block:0,final:0}};});
      const cfg={agents:{list:[{id:"original"},{id:"replacement",default:true}]},bindings:[{agentId:"replacement",match:{channel:OPENCLAW_CHANNEL_ID,accountId:"tertiary"}}]};
      f.accept("Keep original owner");await f.dispatch(channel,cfg,"tertiary");
      expect(f.routes.at(-1)).toEqual({agentId:"original",accountId:"secondary",sessionKey:key,storePath:f.storePath});
      await f.reopen();f.accept("Still original owner");await f.dispatch(channel,cfg,"tertiary");
      expect(f.routes.at(-1)).toEqual({agentId:"original",accountId:"secondary",sessionKey:key,storePath:f.storePath});
    } finally {f.close();}
  });

  it("retains the actual HTTP cancellation correlation exactly once across replay and reopen",async()=>{
    const f=await cancelScenario(impl);
    try {
      expect(await f.core.handle(f.request)).toMatchObject({data:{outcome:"CANCELLED"}});
      await f.reopen();
      const events=f.fixture.account.events.readAfter(null).filter(event=>event.eventType==="conversation.generation.cancelled");
      expect(events).toHaveLength(1);expect(events[0]!.correlationId).toBe(ctx.correlationId);
    } finally {f.close();}
  });

  it("hides late persisted assistant IDs across reopen without hiding old identical text or the next run",async()=>{
    const f=await cancelScenario(impl);
    try {
      const texts=async()=>(await f.fixture.account.conversations.listMessages(f.cid)).messages as Array<{text:string;sender:string;state:string}>;
      expect((await texts()).filter(row=>row.text==="same text")).toHaveLength(1);
      expect((await texts()).some(row=>row.text==="Keep before cancel")).toBe(true);
      await f.reopen();
      f.manager.appendMessage(assistant("Additional late native write"));
      expect((await texts()).some(row=>row.text==="Additional late native write")).toBe(false);
      const channel=f.runtime(async input=>{
        f.manager.appendMessage(assistant("Previous run write while next turn waits in host queue"));
        input.replyOptions.onAgentRunStart(input.replyOptions.runId);
        f.manager.appendMessage(user("Next user"));await input.replyOptions.onTurnAdopted();
        f.manager.appendMessage(assistant("Next legitimate answer"));await input.dispatcherOptions.deliver({text:"Next legitimate answer"},{kind:"final"});
        return {queuedFinal:true,counts:{tool:0,block:0,final:1}};
      });
      f.accept("Next user");await f.dispatch(channel);
      await f.reopen();const rows=await texts();
      expect(rows.filter(row=>row.text==="same text")).toHaveLength(1);
      expect(rows.some(row=>row.text==="Additional late native write")).toBe(false);
      expect(rows.some(row=>row.text==="Next legitimate answer")).toBe(true);
      expect(rows.some(row=>row.text==="Previous run write while next turn waits in host queue")).toBe(false);
      // A different native session is a new history identity, independent of the old cancellation.
      const next=SessionManager.create(dirname(f.storePath),dirname(f.storePath));next.appendMessage(user("Reset user"));next.appendMessage(assistant("Reset answer"));
      writeFileSync(f.storePath,JSON.stringify({[f.sessionKey]:{sessionId:next.getSessionId(),sessionFile:basename(next.getSessionFile()!)}}));
      expect((await texts()).some(row=>row.text==="Reset answer")).toBe(true);
    } finally {f.close();}
  });

  it("keeps true completed output when native abort reports the run already finished",async()=>{
    const f=await setup(impl);
    try {
      const accepted=f.accept("Finished user");f.account.conversations.claimNextMessage();f.account.conversations.markDelivered(accepted.messageId,"cor_adopted");
      f.register(f.runtime(async()=>({})),async()=>{f.manager.appendMessage(assistant("Completed before abort"));f.account.conversations.markCompleted(accepted.messageId,"cor_complete");return {ok:true,aborted:false};});
      const result=await f.core.handle({context:ctx,method:"POST",target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:ctx.requestId,body:{requestId:ctx.requestId}});
      expect(result.data).toMatchObject({outcome:"ALREADY_COMPLETED"});await f.reopen();
      expect((await f.account.conversations.listMessages(f.cid)).messages).toEqual(expect.arrayContaining([expect.objectContaining({text:"Completed before abort"})]));
      expect(f.account.events.readAfter(null).filter(event=>event.eventType==="conversation.generation.cancelled")).toHaveLength(0);
    } finally {f.close();}
  });

  it("accepts canonical clientMessageId independent of authenticated requestId while rejecting malformed bodies",async()=>{
    const f=await setup(impl);
    try {
      const accepted=f.accept("Queued user");
      const base={context:ctx,method:"POST" as const,target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:ctx.requestId};
      const result=await f.core.handle({...base,body:{clientMessageId:"cancel_client_identifier"}});
      expect(result.data).toMatchObject({outcome:"CANCELLED"});
      expect(await f.core.handle({...base,body:{clientMessageId:"cancel_client_identifier"}})).toEqual(result);
      for (const body of [{clientMessageId:"bad id"},{clientMessageId:"valid",requestId:ctx.requestId},{requestId:"wrong"},{clientMessageId:"valid",extra:true}]) {
        expect((await f.core.handle({...base,body})).error).toBeDefined();
      }
      expect((await f.core.handle({...base,idempotencyKey:"wrong",body:{clientMessageId:"valid"}})).error).toBeDefined();
    } finally {f.close();}
  });
  it("filters late native rows for another reader while the abort receipt is still pending",async()=>{
    const f=await setup(impl);let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
    let aborted!:()=>void;const sawAbort=new Promise<void>(resolve=>{aborted=resolve;});
    let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
    f.manager.appendMessage(assistant("保留 🌙"));
    const transcript=f.manager.getSessionFile()!;
    writeFileSync(transcript,readFileSync(transcript,"utf8").replaceAll("\n","\r\n"));
    const channel=f.runtime(async input=>{
      input.replyOptions.onAgentRunStart(input.replyOptions.runId);
      f.manager.appendMessage(user("Pending cancellation"));await input.replyOptions.onTurnAdopted();start();
      await new Promise<void>(resolve=>input.replyOptions.abortSignal.addEventListener("abort",()=>resolve(),{once:true}));
      f.manager.appendMessage(assistant("Late while abort pending"));aborted();await held;
      return {queuedFinal:false,counts:{tool:0,block:0,final:0}};
    });
    f.register(channel);const accepted=f.accept("Pending cancellation");const run=f.dispatch(channel);await started;
    const cancelling=f.core.handle({context:ctx,method:"POST",target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:ctx.requestId,body:{clientMessageId:"client_cancel_pending"}});
    try {
      await sawAbort;const reader=await f.core.openGatewayAccount(ctx.accountId);
      try {
        expect(reader.conversations.workflow.current(f.cid)?.state).toBe("unknown");
        const rows=(await reader.conversations.listMessages(f.cid)).messages as Array<{text:string}>;
        expect(rows.some(row=>row.text==="same text")).toBe(true);
        expect(rows.some(row=>row.text==="保留 🌙")).toBe(true);
        expect(rows.some(row=>row.text==="Late while abort pending")).toBe(false);
      } finally {reader.close();}
    } finally {release();await run;await cancelling;f.close();}
  });

  it("signals abort despite unreadable session metadata or a damaged transcript, retaining prior history",async()=>{
    for (const damage of ["store","transcript","missing-transcript"]) {
      const f=await setup(impl);let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve;});
      let aborted!:()=>void;const sawAbort=new Promise<void>(resolve=>{aborted=resolve;});
      let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
      const channel=f.runtime(async input=>{
        input.replyOptions.onAgentRunStart(input.replyOptions.runId);
        f.manager.appendMessage(user("Cancel with damaged history"));await input.replyOptions.onTurnAdopted();
        input.replyOptions.abortSignal.addEventListener("abort",()=>aborted(),{once:true});start();await held;
        return {queuedFinal:false,counts:{tool:0,block:0,final:0}};
      });
      f.register(channel);const accepted=f.accept("Cancel with damaged history");const run=f.dispatch(channel);await started;
      const path=damage==="store" ? f.storePath : f.manager.getSessionFile()!;const original=readFileSync(path);
      if (damage==="store") writeFileSync(path,"invalid store JSON");
      else if (damage==="missing-transcript") renameSync(path,`${path}.held`);
      else appendFileSync(path,"invalid transcript JSON\n");
      const cancelling=f.core.handle({context:ctx,method:"POST",target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:ctx.requestId,body:{clientMessageId:`client_cancel_${damage}`}});
      try {
        expect(await Promise.race([sawAbort.then(()=>true),cancelling.then(()=>false)])).toBe(true);
        if (damage==="missing-transcript") renameSync(`${path}.held`,path);else writeFileSync(path,original);
        f.manager.appendMessage(assistant("Late after damaged history repair"));
        const rows=(await f.account.conversations.listMessages(f.cid)).messages as Array<{text:string}>;
        expect(rows.some(row=>row.text==="same text")).toBe(true);
        expect(rows.some(row=>row.text==="Late after damaged history repair")).toBe(false);
      } finally {writeFileSync(path,original);release();await run;await cancelling;f.close();}
    }
  });

  it("retains the original persisted boundary and correlation after OUTCOME_UNKNOWN and retry",async()=>{
    const f=await setup(impl);let attempts=0;
    try {
      const accepted=f.accept("Retry unknown cancellation");f.account.conversations.claimNextMessage();f.account.conversations.markDelivered(accepted.messageId,"cor_adopted");
      f.core.setGenerationCanceller!(async(_accountId,conversationId,generationId)=>{
        await f.account.conversations.beginHostCancellation(conversationId,generationId);
        f.manager.appendMessage(assistant(`Late unknown attempt ${++attempts}`));return attempts===1 ? "OUTCOME_UNKNOWN" : "CANCELLED";
      });
      const make=(requestId:string)=>({context:{...ctx,requestId,correlationId:`cor_${requestId}`},method:"POST" as const,target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:requestId,body:{clientMessageId:`client_${requestId}`}});
      expect((await f.core.handle(make("req_unknown"))).data).toMatchObject({outcome:"OUTCOME_UNKNOWN"});
      await f.reopen();
      expect((await f.account.conversations.listMessages(f.cid)).messages).not.toEqual(expect.arrayContaining([expect.objectContaining({text:"Late unknown attempt 1"})]));
      expect((await f.core.handle(make("req_retry"))).data).toMatchObject({outcome:"CANCELLED"});
      const rows=(await f.account.conversations.listMessages(f.cid)).messages as Array<{text:string}>;
      expect(rows.some(row=>row.text==="same text")).toBe(true);
      expect(rows.some(row=>row.text.startsWith("Late unknown attempt"))).toBe(false);
      expect(f.account.events.readAfter(null).find(event=>event.eventType==="conversation.generation.cancelled")?.correlationId).toBe("cor_req_unknown");
    } finally {f.close();}
  });

  it("deactivates unsupported cancellation and captures a fresh boundary for a later valid attempt",async()=>{
    const f=await setup(impl);let attempts=0;
    try {
      const accepted=f.accept("Retry cancellation");f.account.conversations.claimNextMessage();f.account.conversations.markDelivered(accepted.messageId,"cor_adopted");
      f.core.setGenerationCanceller!(async(_accountId,conversationId,generationId)=>{
        await f.account.conversations.beginHostCancellation(conversationId,generationId);
        if (++attempts===1) return "UNSUPPORTED";
        f.manager.appendMessage(assistant("Late in second cancellation"));return "CANCELLED";
      });
      const make=(requestId:string)=>({context:{...ctx,requestId,correlationId:`cor_${requestId}`},method:"POST" as const,target:`/open-android-intelligence/v2/conversations/${f.cid}/generations/${accepted.generationId}/cancel`,idempotencyKey:requestId,body:{clientMessageId:`client_${requestId}`}});
      expect((await f.core.handle(make("req_unsupported"))).data).toMatchObject({outcome:"UNSUPPORTED"});
      f.manager.appendMessage(assistant("Legitimate between attempts"));
      expect((await f.account.conversations.listMessages(f.cid)).messages).toEqual(expect.arrayContaining([expect.objectContaining({text:"Legitimate between attempts"})]));
      expect((await f.core.handle(make("req_supported"))).data).toMatchObject({outcome:"CANCELLED"});
      const rows=(await f.account.conversations.listMessages(f.cid)).messages as Array<{text:string}>;
      expect(rows.some(row=>row.text==="Legitimate between attempts")).toBe(true);
      expect(rows.some(row=>row.text==="Late in second cancellation")).toBe(false);
      expect(f.account.events.readAfter(null).find(event=>event.eventType==="conversation.generation.cancelled")?.correlationId).toBe("cor_req_supported");
    } finally {f.close();}
  });

});
