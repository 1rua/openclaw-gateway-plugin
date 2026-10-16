import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { createGatewayCore, type VerifiedRequestContext } from "../src/core/gateway-core.js";
import { registerOpenAndroidIntelligenceGateway as registerSource, type OpenClawChannelPlugin } from "../src/host/channel-adapter.js";
import { OPENCLAW_CHANNEL_ID, type OpenClawInboundRuntime } from "../src/host/inbound-dispatch.js";

// These internal entrypoints deliberately exercise the installed, exact pinned
// host implementation. Production uses only the public runtime/SDK surfaces.
const dist = resolve(dirname(createRequire(import.meta.url).resolve("openclaw/plugin-sdk/routing")), "..");
const loadNative = (file: string): Promise<Record<string, any>> => import(pathToFileURL(join(dist, file)).href);
const { commandsHandlers } = await loadNative("commands-CM7DPbT8.js");
const { n: createGatewaySession } = await loadNative("session-create-service-14oZxrT5.js");
const { i: registerPluginCommand, S: clearPluginCommandsForPlugin } = await loadNative("command-registration-tKF3dsKu.js");
const context: VerifiedRequestContext = { accountId:"acct_catalog",deviceId:"dev_catalog",sessionId:"sess_catalog",
  requestId:"req_catalog",correlationId:"cor_catalog",pairingGeneration:1,grantRevision:1 };
const catalogRequest = { context, method:"GET" as const, target:"/open-android-intelligence/v2/commands" };

const registerRuntime = (await import(new URL("../runtime/src/host/channel-adapter.js", import.meta.url).href)).registerOpenAndroidIntelligenceGateway as typeof registerSource;

const setup = (cfg: Record<string, unknown>, register: typeof registerSource) => {
  const root = mkdtempSync(join(tmpdir(), "oai-native-catalog-"));
  const storePath = join(root, "sessions.json");
  const config = { ...cfg, session:{store:storePath} };
  const core = createGatewayCore({storageRoot:join(root,"gateway"),attachmentMasterKey:Buffer.alloc(32,7)});
  const channelRuntime: OpenClawInboundRuntime = {
    inbound:{run:async()=>({}),buildContext:value=>value},
    routing:{resolveAgentRoute:value=>resolveAgentRoute(value as Parameters<typeof resolveAgentRoute>[0])},
    session:{resolveStorePath:()=>storePath,recordInboundSession:async()=>{}},
    reply:{dispatchReplyWithBufferedBlockDispatcher:async()=>({})},
  };
  const calls:Array<{method:string;params?:Record<string,unknown>}> = [];
  let channel: OpenClawChannelPlugin | undefined;
  register({gatewayCore:core,hostVersion:"2026.7.1",config,
    runtime:{channel:channelRuntime,gateway:{request:async(method,params)=>{
      calls.push({method,params});
      if (method === "commands.list") return await new Promise((resolve,reject)=>commandsHandlers[method]({params,
        context:{getRuntimeConfig:()=>config},respond:(ok:boolean,payload:unknown,error:unknown)=>ok ? resolve(payload) : reject(error)}));
      if (method === "sessions.create") {
        const result = await createGatewaySession({cfg:config,...params});
        if (!result.ok) throw new Error(result.error?.message);
        return result;
      }
      throw new Error(`unexpected native method: ${method}`);
    }}},registerChannel:value=>{channel="plugin" in value ? value.plugin : value;},registerHttpRoute:()=>{}});
  return {core,calls,storePath,start:async(accountId:string)=>{
    const controller=new AbortController();controller.abort();
    await channel!.gateway!.startAccount({accountId,cfg:config,abortSignal:controller.signal,channelRuntime});
  }};
};

const workspaceWithSkill = (name:string) => {
  const workspace=mkdtempSync(join(tmpdir(),"oai-native-skill-"));
  const directory=join(workspace,"skills",name);mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,"SKILL.md"),`---\nname: ${name}\ndescription: Test ${name} skill\nuser-invocable: true\n---\nTest instructions.\n`);
  return workspace;
};

describe.each([{flavor:"source",register:registerSource},{flavor:"runtime",register:registerRuntime}])("$flavor native OpenClaw catalog routing and session labels",({register})=>{
  it("uses the active account's routed agent workspace instead of the host default",async()=>{
    const {core,calls,start}=setup({agents:{list:[{id:"main",default:true,workspace:workspaceWithSkill("main_marker")},
      {id:"alternate",workspace:workspaceWithSkill("alternate_marker")}]},
      bindings:[{agentId:"alternate",match:{channel:OPENCLAW_CHANNEL_ID,accountId:"secondary"}}]},register);
    await start("secondary");
    const result=await core.handle(catalogRequest);
    expect(result.error).toBeUndefined();
    const invocations=(result.data!.commands as Array<{invocation:string}>).map(command=>command.invocation);
    expect(invocations).toContain("/alternate_marker");expect(invocations).not.toContain("/main_marker");
    expect(calls[0]!.params!.agentId).toBe("alternate");
  });

  it("filters plugin commands through the native provider visibility rule",async()=>{
    const pluginId="oai-catalog-routing-regression";
    const commands=[{name:"catalog_common"},{name:"catalog_android",channels:[OPENCLAW_CHANNEL_ID]},
      {name:"catalog_telegram",channels:["telegram"]}];
    try {
      for (const command of commands) expect(registerPluginCommand(pluginId,{...command,description:command.name,
        handler:async()=>({text:"unused"})})).toEqual({ok:true});
      const {core,calls}=setup({},register);
      const result=await core.handle(catalogRequest);expect(result.error).toBeUndefined();
      const invocations=(result.data!.commands as Array<{invocation:string}>).map(command=>command.invocation);
      expect(invocations).toContain("/catalog_common");expect(invocations).toContain("/catalog_android");
      expect(invocations).not.toContain("/catalog_telegram");
      expect(calls[0]!.params!.provider).toBe(OPENCLAW_CHANNEL_ID);
    } finally {clearPluginCommandsForPlugin(pluginId);}
  });

  it("creates two same-title native sessions and replays without consuming a unique label",async()=>{
    const {core,calls,storePath}=setup({},register);
    const makeRequest=(requestId:string,clientConversationId:string)=>({context:{...context,requestId},method:"POST" as const,
      target:"/open-android-intelligence/v2/conversations",idempotencyKey:requestId,body:{clientConversationId,title:"Weekly notes"}});
    const first=await core.handle(makeRequest("req_first","cc_first"));
    const second=await core.handle(makeRequest("req_second","cc_second"));
    expect(first.error).toBeUndefined();expect(second.error).toBeUndefined();
    expect(first.data!.conversation).toMatchObject({title:"Weekly notes"});
    expect(second.data!.conversation).toMatchObject({title:"Weekly notes"});
    expect((first.data!.conversation as {conversationId:string}).conversationId).not.toBe((second.data!.conversation as {conversationId:string}).conversationId);
    expect(await core.handle(makeRequest("req_second","cc_second"))).toEqual(second);
    expect(calls).toHaveLength(2);expect(calls.every(call=>!("label" in call.params!))).toBe(true);
    const sessions=Object.values(JSON.parse(readFileSync(storePath,"utf8"))) as Array<{sessionId:string;label?:string}>;
    expect(new Set(sessions.map(session=>session.sessionId)).size).toBe(2);
    expect(sessions.every(session=>session.label===undefined)).toBe(true);
  });
});
