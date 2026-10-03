import {generateKeyPairSync,sign} from "node:crypto";
import {mkdtempSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import canonicalize from "canonicalize";
import {describe,it,expect} from "vitest";
import {createGatewayCore,type VerifiedRequestContext} from "../src/core/gateway-core.js";
import {PairingInvites} from "../src/core/pairing-invites.js";
import {HistoryMedia} from "../src/core/history-media.js";

const root=()=>mkdtempSync(join(tmpdir(),"oai-workflow-"));
const ctx:VerifiedRequestContext={accountId:"acct_workflow",deviceId:"dev_workflow",sessionId:"sess_one",pairingGeneration:1,grantRevision:1,requestId:"req_batch",correlationId:"cor_batch"};
const body={clientBatchId:"cb_one",joinMode:"newline-v1",members:[{clientMessageId:"cm_one",text:"  中文\n"},{clientMessageId:"cm_two",text:"🙂 second  "}]};

describe("durable conversation batches",()=> {
  it("joins exactly once, replays identities, expands native history and rejects changed retries",async()=> {
    const account=await createGatewayCore({storageRoot:root(),attachmentMasterKey:Buffer.alloc(32,4)}).openGatewayAccount(ctx.accountId);
    try {
      const cid=account.conversations.create({clientConversationId:"cc_one",correlationId:"cor_one"}).conversationId;
      const accept=(input:typeof body)=>account.store.transaction(()=>account.conversations.workflow.acceptBatch(cid,input,ctx,m=>account.conversations.acceptMessage({...m,conversationId:cid,attachmentIds:[],deviceId:ctx.deviceId,requestId:ctx.requestId,correlationId:ctx.correlationId,emitQueued:false})));
      const receipt=accept(body);expect(accept(body)).toEqual(receipt);
      const events=account.events.readAfter(null);expect(events).toHaveLength(2);expect(new Set(events.map(e=>e.payload.generationId))).toEqual(new Set([receipt.generationId]));
      const first=account.conversations.claimNextMessage()!;expect(first.text).toBe("  中文\n\n🙂 second  ");expect(account.conversations.claimNextMessage()).toBeUndefined();
      const expanded=account.conversations.workflow.expandHistory({messageId:first.messageId,sender:"user",text:first.text,parts:[],state:"CONFIRMED"});
      expect(expanded.map(m=>m.text)).toEqual(body.members.map(m=>m.text));
      expect(()=>accept({...body,members:[{clientMessageId:"cm_one",text:"changed"}]})).toThrow("IDEMPOTENCY_CONFLICT");
      account.conversations.markDelivered(first.messageId,"cor_adopted");account.conversations.markCompleted(first.messageId,"cor_complete");
      expect(account.store.database.prepare("SELECT body FROM messages").all().every(r=>(r as {body:string}).body==="")).toBe(true);
    } finally {account.close();}
  });
  it("does not cancel or unblock a thread without a native cancellation receipt",async()=> {
    const account=await createGatewayCore({storageRoot:root(),attachmentMasterKey:Buffer.alloc(32,4)}).openGatewayAccount(ctx.accountId);
    try {
      const cid=account.conversations.create({clientConversationId:"cc_one",correlationId:"cor_one"}).conversationId;
      const one=account.conversations.acceptMessage({conversationId:cid,clientMessageId:"cm_one",text:"first",attachmentIds:[],deviceId:ctx.deviceId,requestId:ctx.requestId,correlationId:ctx.correlationId});
      account.conversations.claimNextMessage();
      const two=account.conversations.acceptMessage({conversationId:cid,clientMessageId:"cm_two",text:"second",attachmentIds:[],deviceId:ctx.deviceId,requestId:"req_two",correlationId:"cor_two"});
      expect(await account.conversations.workflow.prepareCancel(cid,one.generationId!,ctx,async()=>"OUTCOME_UNKNOWN")).toBe("OUTCOME_UNKNOWN");
      expect(account.conversations.claimNextMessage()).toBeUndefined();
      await expect(account.conversations.workflow.prepareCancel(cid,one.generationId!,{...ctx,deviceId:"dev_other"},async()=>"CANCELLED")).rejects.toThrow("PAIRING_GENERATION_STALE");
      account.conversations.workflow.finishCancel(cid,one.generationId!,"CANCELLED",ctx);
      expect(account.conversations.claimNextMessage()?.messageId).toBe(two.messageId);
    }finally{account.close();}
  });
});

describe("account invitation and paired device proof",()=> {
  it("uses five minute one-use invitations and scoped, one-use Ed25519 device challenges",async()=> {
    const core=createGatewayCore({storageRoot:root(),attachmentMasterKey:Buffer.alloc(32,4)});
    const account=await core.openGatewayAccount(ctx.accountId);const other=await core.openGatewayAccount("acct_other");
    try {
      account.credentials.setPassword("real-test-password");other.credentials.setPassword("different");
      const invites=new PairingInvites(account.store,account.sessions,ctx.accountId);const now=new Date();
      const invitation=invites.issue("https://gateway.example",undefined,now,core.gatewayIdentity!());
      expect(Date.parse(invitation.expiresAt)-now.getTime()).toBe(300_000);expect(new URL(invitation.qrPayload).searchParams.get("invitationId")).toBe(invitation.invitationId);
      const keys=generateKeyPairSync("ed25519");const publicKey=keys.publicKey.export({format:"der",type:"spki"}).subarray(-32).toString("base64url");
      const facts=invites.challenge(invitation.code,"neg_one",{installationId:"install_one",displayName:"phone",devicePublicKey:publicKey},now);
      const signature=sign(null,Buffer.from("OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n"+canonicalize(facts)),keys.privateKey).toString("base64url");
      expect(()=>invites.exchange(String(facts.challengeId),signature,"neg_wrong","cor_one",now)).toThrow("AUTHENTICATION_FAILED");
      const session=invites.exchange(String(facts.challengeId),signature,"neg_one","cor_one",now);
      expect(()=>invites.exchange(String(facts.challengeId),signature,"neg_one","cor_two",now)).toThrow("AUTHENTICATION_FAILED");
      const challenge=invites.deviceChallenge("neg_device","install_one",session.deviceId,now);
      const request={accountId:ctx.accountId,negotiationId:"neg_device",installationId:"install_one",deviceId:session.deviceId,challenge:challenge.challenge,signature:sign(null,Buffer.from("OPEN_ANDROID_INTELLIGENCE_DEVICE_SESSION_V1\n"+canonicalize(challenge)),keys.privateKey).toString("base64url")};
      expect(()=>new PairingInvites(other.store,other.sessions,"acct_other").deviceExchange(request,"cor_bad",now)).toThrow("AUTHENTICATION_FAILED");
      const next=invites.deviceExchange(request,"cor_device",now);expect(next.deviceId).toBe(session.deviceId);expect(next.sessionId).not.toBe(session.sessionId);
      expect(()=>invites.deviceExchange(request,"cor_replay",now)).toThrow("AUTHENTICATION_FAILED");
      expect(JSON.stringify(account.audit.list())).toContain("account-invitation");expect(JSON.stringify(account.audit.list())).not.toContain(invitation.code);
    }finally{account.close();other.close();}
  });
});

it("reads only the scoped host original, consumes grants once and preserves unavailable metadata",async()=> {
  const directory=root();const mediaRoot=join(directory,"media");mkdirSync(mediaRoot);const path=join(mediaRoot,"image.png");writeFileSync(path,Buffer.from("real-original"));
  const account=await createGatewayCore({storageRoot:directory,attachmentMasterKey:Buffer.alloc(32,4)}).openGatewayAccount(ctx.accountId);
  try {
    const cid=account.conversations.create({clientConversationId:"cc_media",correlationId:"cor_media"}).conversationId;
    const media=new HistoryMedia(account.store,ctx.accountId);const ref=media.register(cid,"msg_media",path,"image/png",[mediaRoot]);const id=String(ref.attachmentId);
    const grant=media.grant(cid,id,ctx);expect(()=>media.content(cid,id,String(grant.grantId),{...ctx,deviceId:"dev_other"})).toThrow("AUTHENTICATION_FAILED");
    expect(Buffer.from(media.content(cid,id,String(grant.grantId),ctx).body).toString()).toBe("real-original");expect(()=>media.content(cid,id,String(grant.grantId),ctx)).toThrow("AUTHENTICATION_FAILED");
    writeFileSync(path,Buffer.from("changed"));expect(media.metadata(cid,id)).toMatchObject({remoteAvailable:false,status:"REMOTE_UNAVAILABLE",filename:"image.png"});
  }finally{account.close();}
});
