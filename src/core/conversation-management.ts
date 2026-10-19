import { createHash } from "node:crypto";
import type { GatewayAccountStore } from "./account-store.js";
import type { ConversationPort } from "./conversation-port.js";
import type { EventStore } from "./event-store.js";
import { readNativeSessionState } from "../host/native-history.js";
import type { HostSessionBinding } from "../host/host-session.js";

export type ConversationOrganization = {
  revision: number; sortMode: "updated-desc" | "custom"; customOrder: string[];
  folders: Array<{folderId:string;name:string}>; assignments: Record<string,string>;
};
const organizationKey = "conversation-organization:v1";
const empty = ():ConversationOrganization => ({revision:0,sortMode:"updated-desc",customOrder:[],folders:[],assignments:{}});
type ManagementState = {archived?:boolean;deleted?:boolean;pending?:boolean;pendingRequestId?:string;
  pendingOperation?:"archive"|"delete";pendingArchived?:boolean;updatedAt?:string};
type NativeObservation = Pick<HostSessionBinding,"storePath"|"sessionKey"> & {materialized:boolean};

/** All rows and cursors belong to this authenticated account's database. */
export class ConversationManagement {
  constructor(private store:GatewayAccountStore, private conversations:ConversationPort, private events:EventStore) {}
  private read<T>(key:string):T|undefined {
    const row=this.store.database.prepare("SELECT value FROM account_metadata WHERE key=?").get(key) as {value:string}|undefined;
    return row ? this.store.openJson(row.value,key) as T : undefined;
  }
  private write(key:string,value:unknown):void {
    this.store.database.prepare("INSERT OR REPLACE INTO account_metadata(key,value) VALUES (?,?)").run(key,this.store.sealJson(value,key));
  }
  state(id:string):ManagementState {return this.read(`conversation-management:${id}`) ?? {};}
  private sameNativeBinding(left:Pick<HostSessionBinding,"storePath"|"sessionKey">,right:HostSessionBinding):boolean {
    return left.storePath===right.storePath && left.sessionKey.toLowerCase()===right.sessionKey.toLowerCase();
  }
  prepareNativeBinding(id:string,binding:HostSessionBinding):void {
    const previous=this.conversations.workflow.get<HostSessionBinding>(`host-session:${id}`);
    if(!previous || !this.sameNativeBinding(previous,binding)) this.write(`conversation-native-seen:${id}`,{storePath:binding.storePath,sessionKey:binding.sessionKey,materialized:false} satisfies NativeObservation);
  }
  rememberNativeSession(id:string,binding:HostSessionBinding):void {
    this.write(`conversation-native-seen:${id}`,{storePath:binding.storePath,sessionKey:binding.sessionKey,materialized:true} satisfies NativeObservation);
  }
  touch(id:string,now=new Date()):void {this.write(`conversation-management:${id}`,{...this.state(id),updatedAt:now.toISOString()});}
  requireVisible(id:string):void {const state=this.state(id);if(state.deleted) throw new Error("CONVERSATION_NOT_FOUND");if(state.pending) throw new Error("CONVERSATION_BUSY");}
  requireWritable(id:string):void {
    this.requireVisible(id);this.record(id);this.requireVisible(id);
    if(this.state(id).archived) throw new Error("CONVERSATION_ARCHIVED");
  }
  organization():ConversationOrganization {return structuredClone(this.read<ConversationOrganization>(organizationKey) ?? empty());}
  replace(body:Omit<ConversationOrganization,"revision"> & {expectedRevision:number},correlationId:string):ConversationOrganization {
    return this.store.transaction(()=> {
      const current=this.organization();
      if(current.revision!==body.expectedRevision) throw new Error("ORGANIZATION_CONFLICT");
      const ids=new Set(this.conversations.list().map(row=>row.conversationId));
      const folders=new Set(body.folders.map(row=>row.folderId));
      if(folders.size!==body.folders.length || new Set(body.folders.map(row=>row.name.toLocaleLowerCase())).size!==body.folders.length
        || body.customOrder.some(id=>!ids.has(id)) || Object.entries(body.assignments).some(([id,folder])=>!ids.has(id)||!folders.has(folder))) throw new Error("SCHEMA_INVALID");
      const next:ConversationOrganization={revision:current.revision+1,sortMode:body.sortMode,customOrder:[...body.customOrder],folders:body.folders.map(row=>({...row})),assignments:{...body.assignments}};
      this.write(organizationKey,next);
      this.events.append({eventType:"conversation.organization.updated",correlationId,payload:{revision:next.revision}});
      return next;
    });
  }
  private removeOrganization(id:string,correlationId:string):void {
    const current=this.organization();
    if(!current.customOrder.includes(id) && !Object.hasOwn(current.assignments,id)) return;
    current.customOrder=current.customOrder.filter(value=>value!==id);delete current.assignments[id];current.revision++;
    this.write(organizationKey,current);
    this.events.append({eventType:"conversation.organization.updated",correlationId,payload:{revision:current.revision}});
  }
  begin(id:string,requestId:string,operation:"archive"|"delete",archived?:boolean):void {
    const prior=this.state(id);
    if(prior.deleted) throw new Error("CONVERSATION_NOT_FOUND");
    if(prior.pending && prior.pendingRequestId!==requestId) throw new Error("OUTCOME_UNKNOWN");
    if(prior.pending && (prior.pendingOperation!==operation || prior.pendingArchived!==archived)) throw new Error("IDEMPOTENCY_CONFLICT");
    if(!prior.pending) this.conversations.get(id);
    const active=this.conversations.workflow.current(id);
    if(active && ["queued","running","unknown","cancel_requested"].includes(String(active.state))) throw new Error("CONVERSATION_BUSY");
    const queued=this.store.database.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND status IN ('queued','sending','delivered') LIMIT 1").get(id);
    if(queued) throw new Error("CONVERSATION_BUSY");
    this.write(`conversation-management:${id}`,{...this.state(id),pending:true,pendingRequestId:requestId,pendingOperation:operation,...(archived!==undefined ? {pendingArchived:archived} : {})});
  }
  abort(id:string,requestId:string):void {
    const state=this.state(id);
    if(state.pendingRequestId!==requestId) return;
    delete state.pending;delete state.pendingRequestId;delete state.pendingOperation;delete state.pendingArchived;
    this.write(`conversation-management:${id}`,state);
  }
  commit(id:string,operation:"archive"|"delete",archived:boolean|undefined,correlationId:string,now=new Date()):Record<string,unknown> {
    return this.store.transaction(()=> {
      const state:ManagementState={...this.state(id),updatedAt:now.toISOString(),...(operation==="delete" ? {deleted:true} : {archived:archived!})};
      delete state.pending;delete state.pendingRequestId;delete state.pendingOperation;delete state.pendingArchived;
      this.write(`conversation-management:${id}`,state);
      if(operation==="delete") this.removeOrganization(id,correlationId);
      this.events.append({eventType:"conversation.updated",correlationId,payload:{conversationId:id,...(operation==="delete" ? {deleted:true} : {archived:archived!})},now});
      return operation==="delete" ? {conversationId:id,deleted:true} : {conversation:this.record(id)};
    });
  }
  private nativeWasMaterialized(id:string,binding:HostSessionBinding):boolean {
    const observed=this.read<boolean|NativeObservation>(`conversation-native-seen:${id}`);
    if(observed===true || observed && typeof observed==="object" && this.sameNativeBinding(observed,binding) && observed.materialized) return true;
    const checkpoint=this.conversations.workflow.get<HostSessionBinding & {watermark?:{sessionId?:string}}>(`native-checkpoint:${id}`);
    if(checkpoint && this.sameNativeBinding(checkpoint,binding) && typeof checkpoint.watermark?.sessionId==="string" && checkpoint.watermark.sessionId.length>0) return true;
    // New/rebound routes have their own observation, so old conversation-wide
    // receipts cannot prove that the current native session ever existed.
    if(observed!==undefined) return false;
    // Legacy bindings can exist before native admission. Only adopted messages,
    // imported native identities or a checkpoint for this route prove creation.
    if(this.store.database.prepare("SELECT 1 FROM messages WHERE conversation_id=? AND (delivered_at IS NOT NULL OR status IN ('delivered','completed')) LIMIT 1").get(id)) return true;
    const prefix=`history-native:${id}:`;
    if(this.store.database.prepare("SELECT 1 FROM account_metadata WHERE substr(key,1,?)=? LIMIT 1").get(prefix.length,prefix)) return true;
    return false;
  }
  record(id:string):Record<string,unknown> {
    const row=this.store.database.prepare("SELECT c.*,MAX(m.created_at) AS last_message_at FROM conversations c LEFT JOIN messages m ON m.conversation_id=c.conversation_id WHERE c.conversation_id=? GROUP BY c.conversation_id").get(id) as Record<string,unknown>|undefined;
    if(!row || this.state(id).deleted) throw new Error("CONVERSATION_NOT_FOUND");
    let state=this.state(id);
    const binding=this.conversations.workflow.get<HostSessionBinding>(`host-session:${id}`);
    let native:ReturnType<typeof readNativeSessionState>;
    if(binding) {
      native=readNativeSessionState(binding);
      const materialized=!!native || this.nativeWasMaterialized(id,binding);
      if(materialized) this.rememberNativeSession(id,binding);
      if(!native && !state.pending && materialized) {this.commit(id,"delete",undefined,"native-conversation-sync");throw new Error("CONVERSATION_NOT_FOUND");}
      if(native && !state.pending && state.archived!==native.archived) {state={...state,archived:native.archived};this.write(`conversation-management:${id}`,state);}
    }
    const times=[row.created_at,row.last_message_at,state.updatedAt,native?.updatedAt].filter((value):value is string=>typeof value==="string");
    return {conversationId:id,clientConversationId:String(row.client_conversation_id),title:row.title ?? null,archived:state.archived ?? false,updatedAt:times.sort().at(-1)!};
  }
  page(cursor?:string,limit?:number):Record<string,unknown> {
    if(limit!==undefined && (!Number.isInteger(limit)||limit<1||limit>100)) throw new Error("SCHEMA_INVALID");
    const rows=this.conversations.list().flatMap(row=>{try{return [this.record(row.conversationId)];}catch(error){if((error as Error).message==="CONVERSATION_NOT_FOUND") return [];throw error;}})
      .sort((a,b)=>String(b.updatedAt).localeCompare(String(a.updatedAt))||String(a.conversationId).localeCompare(String(b.conversationId)));
    const revision=parseInt(createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0,13),16)+1;
    let offset=0;
    if(cursor) {
      let saved:{revision:number;offset:number};
      try {saved=this.store.openJson(cursor,"conversation-list:v1") as typeof saved;} catch {throw new Error("SCHEMA_INVALID");}
      if(saved.revision!==revision) throw new Error("CURSOR_EXPIRED");
      if(!Number.isInteger(saved.offset)||saved.offset<0||saved.offset>rows.length) throw new Error("SCHEMA_INVALID");offset=saved.offset;
    }
    const end=offset+(limit ?? rows.length);
    return {conversations:rows.slice(offset,end),snapshotRevision:revision,nextCursor:end<rows.length ? this.store.sealJson({revision,offset:end},"conversation-list:v1") : null};
  }
}
