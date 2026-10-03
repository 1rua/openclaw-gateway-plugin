import {mkdtempSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {expect,it} from "vitest";
import {createGatewayCore} from "../src/core/gateway-core.js";

it("pages a real native JSONL transcript, migrates adopted transport bodies and keeps edited identities",async()=> {
  const directory=mkdtempSync(join(tmpdir(),"oai-native-history-"));
  const core=createGatewayCore({storageRoot:directory,attachmentMasterKey:Buffer.alloc(32,7)});
  let account=await core.openGatewayAccount("acct_history");
  try {
    const cid=account.conversations.create({clientConversationId:"cc_native",correlationId:"cor_create"}).conversationId;
    const accepted=account.conversations.acceptMessage({conversationId:cid,clientMessageId:"cm_legacy",text:"native-0",attachmentIds:[],deviceId:"dev_history",requestId:"req_legacy",correlationId:"cor_legacy"});
    account.store.database.prepare("UPDATE messages SET status='completed' WHERE message_id=?").run(accepted.messageId);
    const storePath=join(directory,"sessions.json"),file=join(directory,"native-session.jsonl");
    const native=Array.from({length:121},(_,i)=>({type:"message",id:`native_${i}`,timestamp:new Date(1_000+i).toISOString(),message:{role:i===120?"assistant":"user",content:i===120?[{type:"thinking",thinking:"PRIVATE REASONING"},{type:"text",text:`native-${i}`}]:`native-${i}`,platform_message_id:i===119?"cm_remote":undefined}}));
    const save=()=>writeFileSync(file,native.map(row=>JSON.stringify(row)).join("\n")+"\n");save();
    writeFileSync(storePath,JSON.stringify({trusted:{sessionId:"native-session"}}));
    core.setHostSessionResolver!((accountId,conversationId)=> {
      expect(accountId).toBe("acct_history");expect(conversationId).toBe(cid);
      return {storePath,sessionKey:"trusted"};
    });
    account.close();account=await core.openGatewayAccount("acct_history");
    let cursor:string|undefined;const rows:Array<Record<string,unknown>>=[];const revisions=new Set<number>();
    do {
      const page=await account.conversations.listMessages(cid,{cursor,limit:23});
      rows.push(...page.messages as Array<Record<string,unknown>>);revisions.add(Number(page.snapshotRevision));cursor=page.nextCursor as string|undefined;
    } while(cursor);
    expect(rows).toHaveLength(121);expect(new Set(rows.map(row=>row.messageId)).size).toBe(121);expect(revisions.size).toBe(1);
    expect(rows[0]?.messageId).toBe(accepted.messageId);expect(rows.at(-1)?.text).toBe("native-120");
    expect(JSON.stringify(rows)).not.toContain("PRIVATE REASONING");
    expect((account.store.database.prepare("SELECT body FROM messages WHERE message_id=?").get(accepted.messageId) as {body:string}).body).toBe("");
    expect((await account.conversations.listMessages(cid,{clientMessageId:"cm_legacy"})).messages).toMatchObject([{messageId:accepted.messageId,text:"native-0"}]);
    expect((await account.conversations.listMessages(cid,{clientMessageId:"cm_remote"})).messages).toMatchObject([{text:"native-119"}]);
    const oldCursor=(await account.conversations.listMessages(cid,{limit:2})).nextCursor as string;
    native[0]!.message.content="edited native history";save();
    await expect(account.conversations.listMessages(cid,{cursor:oldCursor})).rejects.toThrow("CURSOR_EXPIRED");
    expect((await account.conversations.listMessages(cid,{clientMessageId:"cm_legacy"})).messages).toMatchObject([{messageId:accepted.messageId,text:"edited native history"}]);
  } finally {account.close();}
});
