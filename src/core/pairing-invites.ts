import { createHash,createPublicKey,randomBytes,randomUUID,verify } from "node:crypto";
import { CredentialStore } from "./credential-store.js";
import canonicalize from "canonicalize";
import type { GatewayAccountStore } from "./account-store.js";
import type { SessionService,LoginInstallation,SessionBundle } from "./session-service.js";

const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
const domain=Buffer.from("OPEN_ANDROID_INTELLIGENCE_PAIRING_V1\n");
export class PairingInvites {
  constructor(private readonly store:GatewayAccountStore,private readonly sessions:SessionService,private readonly accountId:string) {}
  private put(key:string,value:Record<string,unknown>):void { this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key,this.store.sealJson(value,key)); }
  private get(key:string):Record<string,unknown>|undefined { const r=this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as {value:string}|undefined; return r ? this.store.openJson(r.value,key) as Record<string,unknown> : undefined; }
  private credential():string { return new CredentialStore(this.store).passwordDigest() ?? ""; }
  private prune(now:Date):void {
    const rows=this.store.database.prepare("SELECT key FROM account_metadata WHERE key LIKE 'pairing-invite:%' OR key LIKE 'pairing-challenge:%'").all() as Array<{key:string}>;
    let live=0;
    for (const row of rows) { const saved=this.get(row.key)!;const facts=saved.facts as Record<string,unknown>|undefined;
      if (Date.parse(String(saved.expiresAt ?? facts?.expiresAt))<=now.getTime()) this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(row.key); else live++; }
    if (live>=128) throw new Error("RATE_LIMITED");
  }
  issue(gatewayUrl:string,ttlSeconds=300,now=new Date(),gatewayIdentity:Record<string,unknown>={}):Readonly<{invitationId:string;code:string;expiresAt:string;gatewayIdentityFingerprint:string;qrPayload:string}> {
    const url=new URL(gatewayUrl); if (!["https:","http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || ttlSeconds<30 || ttlSeconds>900) throw new Error("SCHEMA_INVALID");
    this.prune(now);
    const invitationId=`invite_${randomUUID()}`;
    const code=randomBytes(8).toString("hex").toUpperCase(); const key=`pairing-invite:${sha(code)}`;
    const expiresAt=new Date(now.getTime()+ttlSeconds*1000).toISOString();
    this.put(key,{invitationId,expiresAt,credential:this.credential(),pairingGeneration:this.sessions.currentPairingGeneration()});
    const gatewayIdentityFingerprint=`sha256:${sha(canonicalize(gatewayIdentity)!)}`;
    const params=new URLSearchParams({gateway:url.toString().replace(/\/$/u,""),account:this.accountId,invitationId,code,expiresAt,identityFingerprint:gatewayIdentityFingerprint});
    return Object.freeze({invitationId,code,expiresAt,gatewayIdentityFingerprint,qrPayload:`oai://pair?${params}`});
  }
  challenge(code:string,negotiationId:string,installation:LoginInstallation,now=new Date()):Record<string,unknown> {
    this.prune(now);
    if (!/^[A-F0-9]{16}$/.test(code) || !/^[A-Za-z0-9_-]{43}$/.test(installation.devicePublicKey) || Buffer.from(installation.devicePublicKey,"base64url").toString("base64url") !== installation.devicePublicKey
      || !installation.installationId || !installation.displayName || installation.displayName.length>200) throw new Error("AUTHENTICATION_FAILED");
    const inviteKey=`pairing-invite:${sha(code)}`; const invitation=this.get(inviteKey);
    if (!invitation || Date.parse(String(invitation.expiresAt))<=now.getTime() || invitation.credential!==this.credential() || invitation.pairingGeneration!==this.sessions.currentPairingGeneration()) throw new Error("AUTHENTICATION_FAILED");
    const challengeId=`challenge_${randomUUID()}`;
    const facts={challengeId,accountId:this.accountId,negotiationId,installationId:installation.installationId,devicePublicKey:installation.devicePublicKey,
      nonce:randomBytes(32).toString("base64url"),expiresAt:new Date(Math.min(now.getTime()+60_000,Date.parse(String(invitation.expiresAt)))).toISOString()};
    this.put(`pairing-challenge:${challengeId}`,{facts,installation,inviteKey});
    return facts;
  }
  exchange(challengeId:string,signature:string,negotiationId:string,correlationId:string,now=new Date()):SessionBundle {
    return this.store.transaction(()=> {
      const key=`pairing-challenge:${challengeId}`; const saved=this.get(key);
      const facts=saved?.facts as Record<string,unknown>|undefined;
      const invitation=saved ? this.get(String(saved.inviteKey)) : undefined;
      if (!saved || !facts || !invitation || facts.negotiationId!==negotiationId || Date.parse(String(facts.expiresAt))<=now.getTime()
        || invitation.credential!==this.credential() || invitation.pairingGeneration!==this.sessions.currentPairingGeneration()
        || !/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature,"base64url").toString("base64url")!==signature) throw new Error("AUTHENTICATION_FAILED");
      const pub=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(String(facts.devicePublicKey),"base64url")]),format:"der",type:"spki"});
      if (!verify(null,Buffer.concat([domain,Buffer.from(canonicalize(facts)!)]),pub,Buffer.from(signature,"base64url"))) throw new Error("AUTHENTICATION_FAILED");
      this.store.database.prepare("DELETE FROM account_metadata WHERE key IN (?,?)").run(key,String(saved.inviteKey));
      return this.sessions.createInviteSession(saved.installation as LoginInstallation,correlationId,now);
    });
  }

  deviceChallenge(negotiationId:string,installationId:string,deviceId:string,now=new Date()):Record<string,unknown> {
    this.prune(now);
    const row=this.store.database.prepare("SELECT public_key,pairing_generation FROM device_keys WHERE device_id=? AND installation_id=?").get(deviceId,installationId) as {public_key:string;pairing_generation:number}|undefined;
    if (!row) throw new Error("AUTHENTICATION_FAILED");
    const facts={challenge:`challenge_${randomUUID()}`,accountId:this.accountId,negotiationId,installationId,deviceId,nonce:randomBytes(32).toString("base64url"),expiresAt:new Date(now.getTime()+60_000).toISOString()};
    this.put(`pairing-challenge:${facts.challenge}`,{facts,publicKey:row.public_key,pairingGeneration:row.pairing_generation,credential:this.credential()});
    return facts;
  }
  deviceExchange(body:Readonly<Record<string,unknown>>,correlationId:string,now=new Date()):SessionBundle {
    return this.store.transaction(()=> {
      const key=`pairing-challenge:${body.challenge}`;const saved=this.get(key);const facts=saved?.facts as Record<string,unknown>|undefined;
      const row=this.store.database.prepare("SELECT public_key,pairing_generation FROM device_keys WHERE device_id=? AND installation_id=?").get(String(body.deviceId),String(body.installationId)) as {public_key:string;pairing_generation:number}|undefined;
      if (!saved || !facts || !row || saved.publicKey!==row.public_key || saved.pairingGeneration!==row.pairing_generation || saved.credential!==this.credential() || Date.parse(String(facts.expiresAt))<=now.getTime()
        || ["challenge","negotiationId","installationId","deviceId"].some(k=>facts[k]!==body[k])) throw new Error("AUTHENTICATION_FAILED");
      const signature=String(body.signature);
      if (!/^[A-Za-z0-9_-]{86}$/.test(signature) || Buffer.from(signature,"base64url").toString("base64url")!==signature) throw new Error("AUTHENTICATION_FAILED");
      const pub=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(row.public_key,"base64url")]),format:"der",type:"spki"});
      if (!verify(null,Buffer.from("OPEN_ANDROID_INTELLIGENCE_DEVICE_SESSION_V1\n"+canonicalize(facts)),pub,Buffer.from(signature,"base64url"))) throw new Error("AUTHENTICATION_FAILED");
      this.store.database.prepare("DELETE FROM account_metadata WHERE key=?").run(key);
      return this.sessions.createDeviceSession(String(body.installationId),String(body.deviceId),correlationId,now);
    });
  }
}
