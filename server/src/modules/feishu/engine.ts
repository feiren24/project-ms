import { isExistingDatabase } from '../../db/lifecycle.js';
import {randomUUID} from 'node:crypto';
import type Database from 'better-sqlite3';
import type {FeishuDelivery,FeishuDeliveryFilter,FeishuMessage,FeishuRuleDraft,NotificationRule,FeishuBot} from '../../../../shared/src/feishu.js';
import {enqueueJob,initializeJobs} from '../../jobs/store.js';
import {PlanError} from '../planning/errors.js';
import {readFeishuBots,readFeishuRules,readFeishuPreferences,readFeishuCredentials,markFeishuBotTest,feishuMasterKeyAvailable,recordFeishuAudit} from './store.js';
import {initializeFeishuEvents,eventMatches,type FeishuEvent} from './events.js';
import {nextSlot,quietAdjusted,minute,day,initialPeriod,nominalAllowed} from './scheduling.js';
import {baseMessage,buildFeishuMessage,eventMessage} from './messages.js';
import {deliverFeishuMessage} from './transport.js';
export interface FeishuRuntimeOptions {masterKey?:string;getMasterKey?:()=>string|undefined;publicBaseUrl?:string;clock?:()=>Date;transport?:typeof fetch;intervalMs?:number}
/** Resolve at the operation boundary so a saved system key becomes effective without restart. */
export function runtimeFeishuKey(options:FeishuRuntimeOptions):string|undefined {return options.getMasterKey ? options.getMasterKey() : options.masterKey;}
interface Meta {botVersion:number;ruleVersions:Record<string,number>;eventKeys:string[];nominalAt?:string;effectiveAt?:string;periodStart?:string;manualRetry?:boolean}
interface Row {project_id:string;id:string;job_id:string;bot_id:string;status:FeishuDelivery['status'];due_at:string;created_at:string;snapshot_json:string;meta_json:string}
const read=(row:Row)=>({delivery:JSON.parse(row.snapshot_json) as FeishuDelivery,meta:JSON.parse(row.meta_json) as Meta});
function save(db:Database.Database,row:Row,delivery:FeishuDelivery,meta=read(row).meta){db.prepare('UPDATE feishu_deliveries SET status=?,due_at=?,snapshot_json=?,meta_json=? WHERE id=? AND project_id=?').run(delivery.status,delivery.dueAt,JSON.stringify(delivery),JSON.stringify(meta),row.id,row.project_id);row.status=delivery.status;row.due_at=delivery.dueAt;row.snapshot_json=JSON.stringify(delivery);row.meta_json=JSON.stringify(meta);}
export function initializeFeishuEngine(db:Database.Database){
  if (isExistingDatabase(db)) return;initializeJobs(db);db.exec(`CREATE TABLE IF NOT EXISTS feishu_deliveries(project_id TEXT NOT NULL,id TEXT PRIMARY KEY,job_id TEXT NOT NULL UNIQUE,bot_id TEXT NOT NULL,status TEXT NOT NULL,due_at TEXT NOT NULL,created_at TEXT NOT NULL,snapshot_json TEXT NOT NULL,meta_json TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS feishu_deliveries_list ON feishu_deliveries(project_id,created_at DESC);
 CREATE INDEX IF NOT EXISTS feishu_deliveries_due ON feishu_deliveries(status,due_at);
 CREATE TABLE IF NOT EXISTS feishu_event_targets(project_id TEXT NOT NULL,event_key TEXT NOT NULL,bot_id TEXT NOT NULL,delivery_id TEXT NOT NULL,PRIMARY KEY(project_id,event_key,bot_id));
 CREATE TABLE IF NOT EXISTS feishu_rule_schedules(project_id TEXT NOT NULL,rule_id TEXT NOT NULL,rule_version INTEGER NOT NULL,next_nominal_at TEXT NOT NULL,last_nominal_at TEXT,PRIMARY KEY(project_id,rule_id));
 CREATE TABLE IF NOT EXISTS feishu_rule_activation(project_id TEXT NOT NULL,rule_id TEXT NOT NULL,rule_version INTEGER NOT NULL,event_watermark INTEGER NOT NULL,PRIMARY KEY(project_id,rule_id,rule_version));
 CREATE TABLE IF NOT EXISTS feishu_bot_rate(project_id TEXT NOT NULL,bot_id TEXT NOT NULL,next_send_at TEXT NOT NULL,PRIMARY KEY(project_id,bot_id));`);initializeFeishuEvents(db);}
export function activateFeishuRule(db:Database.Database,pid:string,ruleId:string,ruleVersion:number):void {const watermark=(db.prepare('SELECT COALESCE(MAX(rowid),0) AS value FROM feishu_events WHERE project_id=?').get(pid) as {value:number}).value;db.prepare('INSERT OR IGNORE INTO feishu_rule_activation VALUES(?,?,?,?)').run(pid,ruleId,ruleVersion,watermark);}
export function previewFeishuRule(db:Database.Database,pid:string,draft:FeishuRuleDraft,options:FeishuRuntimeOptions={},now=new Date()):FeishuMessage{return buildFeishuMessage(db,pid,draft,now,options.publicBaseUrl);}
export function nextFeishuRun(db:Database.Database,pid:string,draft:FeishuRuleDraft,now:Date):string|null {
 const rule=draft as Partial<NotificationRule>,prefs=readFeishuPreferences(db,pid);
 if(rule.id&&rule.status==='enabled') {const cursor=db.prepare('SELECT next_nominal_at FROM feishu_rule_schedules WHERE project_id=? AND rule_id=? AND rule_version=?').get(pid,rule.id,rule.version) as {next_nominal_at:string}|undefined;if(cursor&&nominalAllowed(db,pid,draft,new Date(cursor.next_nominal_at)))return quietAdjusted(new Date(cursor.next_nominal_at),draft,prefs).toISOString();}
 return nextSlot(db,pid,draft,now,prefs)?.effective.toISOString()??null;
}
function insertDelivery(db:Database.Database,pid:string,bot:FeishuBot,rules:NotificationRule[],kind:FeishuDelivery['kind'],message:FeishuMessage,due:Date,now:Date,dedupeKey:string,extra:Partial<Meta>={}):Row {
 const id=`feishu-${randomUUID()}`,jobId=enqueueJob(db,{projectId:pid,kind:'feishu_delivery',dedupeKey,payload:{deliveryId:id},dueAt:due},now);
 const exists=db.prepare('SELECT * FROM feishu_deliveries WHERE job_id=?').get(jobId) as Row|undefined;if(exists)return exists;
 const delivery:FeishuDelivery={id,version:1,botId:bot.id,botName:bot.name,groupName:bot.groupName,ruleIds:rules.map(rule=>rule.id),ruleName:rules.map(rule=>rule.name).join('、')||'机器人连接测试',kind,status:'pending',message,dueAt:due.toISOString(),createdAt:now.toISOString(),finishedAt:null,attempts:[],error:null,audit:[]};
 const meta:Meta={botVersion:bot.version,ruleVersions:Object.fromEntries(rules.map(rule=>[rule.id,rule.version])),eventKeys:[],...extra};
 const row:Row={project_id:pid,id,job_id:jobId,bot_id:bot.id,status:'pending',due_at:delivery.dueAt,created_at:delivery.createdAt,snapshot_json:JSON.stringify(delivery),meta_json:JSON.stringify(meta)};
 db.prepare('INSERT INTO feishu_deliveries VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(row));return row;
}
export function enqueueFeishuTest(db:Database.Database,pid:string,botId:string,actor:string,now:Date):string {
 const bot=readFeishuBots(db,pid).find(item=>item.id===botId);if(!bot)throw new PlanError(404,'BOT_NOT_FOUND','机器人不存在。');
 const message:FeishuMessage={title:'飞书机器人连接测试',projectName:'项目管理系统',lines:['这是一条由管理员确认发送的连接测试，不包含项目业务数据。','收到后，请返回系统核对目标群名称。'],total:0,url:null,linkLabel:'',mentionAll:false,generatedAt:now.toISOString(),isDemo:false};
 const row=insertDelivery(db,pid,bot,[],'test',message,now,now,`test:${randomUUID()}`);const {delivery}=read(row);delivery.audit.push({at:now.toISOString(),actor,action:'确认发送无业务数据的测试卡片'});save(db,row,delivery);return row.id;
}
function finish(db:Database.Database,row:Row,status:FeishuDelivery['status'],now:Date,error:string|null,delivery=read(row).delivery){delivery.status=status;delivery.error=error;delivery.finishedAt=now.toISOString();delivery.version++;save(db,row,delivery);db.prepare('UPDATE background_jobs SET status=?,finished_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?').run(status==='accepted'?'succeeded':['failed','unknown'].includes(status)?'failed':'missed',now.toISOString(),error,row.job_id);}
export function cancelFeishuPending(db:Database.Database,pid:string,filter:{botId?:string;ruleId?:string},now:Date):void {
 for(const row of db.prepare("SELECT * FROM feishu_deliveries WHERE project_id=? AND status='pending'").all(pid) as Row[]){const {delivery}=read(row);if(filter.botId&&delivery.botId!==filter.botId||filter.ruleId&&!delivery.ruleIds.includes(filter.ruleId))continue;finish(db,row,'cancelled',now,'配置已变更或停用，待发消息已取消。');}
}
export function listFeishuDeliveries(db:Database.Database,pid:string,filter:FeishuDeliveryFilter,now=new Date()):{items:FeishuDelivery[];total:number}{
 const where=['project_id=?'],args:Array<string|number>=[pid];if(filter.status){where.push('status=?');args.push(filter.status);}if(filter.botId){where.push('bot_id=?');args.push(filter.botId);}if(filter.ruleId){where.push("EXISTS(SELECT 1 FROM json_each(json_extract(snapshot_json,'$.ruleIds')) WHERE value=?)");args.push(filter.ruleId);}if(filter.days){where.push('created_at>=?');args.push(new Date(now.getTime()-Math.min(3650,Math.max(1,filter.days))*day).toISOString());}
 const total=(db.prepare(`SELECT COUNT(*) AS total FROM feishu_deliveries WHERE ${where.join(' AND ')}`).get(...args) as {total:number}).total,pageSize=Math.min(100,Math.max(1,filter.pageSize??20)),page=Math.max(1,filter.page??1);
 const items=(db.prepare(`SELECT * FROM feishu_deliveries WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...args,pageSize,(page-1)*pageSize) as Row[]).map(row=>read(row).delivery);return {items,total};
}
export function manageFeishuDelivery(db:Database.Database,pid:string,id:string,action:'retry'|'received',expectedVersion:number,actor:string,now:Date):void {
 db.transaction(()=>manageDelivery(db,pid,id,action,expectedVersion,actor,now))();
}
function manageDelivery(db:Database.Database,pid:string,id:string,action:'retry'|'received',expectedVersion:number,actor:string,now:Date):void {
 const row=db.prepare('SELECT * FROM feishu_deliveries WHERE project_id=? AND id=?').get(pid,id) as Row|undefined;if(!row)throw new PlanError(404,'DELIVERY_NOT_FOUND','发送记录不存在。');const {delivery,meta}=read(row);
 if(delivery.version!==expectedVersion)throw new PlanError(409,'DELIVERY_VERSION_CONFLICT','发送记录已更新，请刷新后核对。');if(!['failed','unknown'].includes(delivery.status))throw new PlanError(422,'DELIVERY_NOT_RECOVERABLE','此记录不需要人工恢复。');
 const operation=action==='received'?'人工核对目标群已收到':'人工确认目标群未收到并重新发送';delivery.audit.push({at:now.toISOString(),actor,action:operation});recordFeishuAudit(db,pid,actor,`${operation} · ${id}`,now);
 if(action==='received'){if(delivery.status!=='unknown')throw new PlanError(422,'DELIVERY_NOT_UNKNOWN','仅结果待核实记录可标记已收到。');finish(db,row,'accepted',now,null,delivery);if(delivery.kind==='test')markFeishuBotTest(db,pid,delivery.botId,meta.botVersion,true,null,now);return;}
 const bot=readFeishuBots(db,pid).find(bot=>bot.id===delivery.botId);if(!bot||!bot.enabled||bot.version!==meta.botVersion)throw new PlanError(422,'BOT_CHANGED','机器人已变更，请从配置页重新测试或启用规则。');
 const rules=readFeishuRules(db,pid);if(delivery.kind!=='test'&&delivery.ruleIds.some(id=>!rules.some(rule=>rule.id===id&&rule.status==='enabled'&&rule.version===meta.ruleVersions[id])))throw new PlanError(422,'RULE_CHANGED','规则已变更或暂停，不能重发旧消息。');
 delivery.version++;delivery.status='pending';delivery.dueAt=now.toISOString();delivery.finishedAt=null;delivery.error=null;meta.manualRetry=true;save(db,row,delivery,meta);db.prepare("UPDATE background_jobs SET status='pending',attempts=0,due_at=?,finished_at=NULL,error=NULL,lease_token=NULL,lease_until=NULL,manual_retries=manual_retries+1 WHERE id=?").run(now.toISOString(),row.job_id);
}
function materializeEvents(db:Database.Database,now:Date,options:FeishuRuntimeOptions){
 const rows=db.prepare('SELECT rowid AS sequence,project_id,event_key,snapshot_json FROM feishu_events WHERE processed=0 ORDER BY rowid LIMIT 200').all() as {sequence:number;project_id:string;event_key:string;snapshot_json:string}[];
 for(const source of rows){const pid=source.project_id,event=JSON.parse(source.snapshot_json) as FeishuEvent,prefs=readFeishuPreferences(db,pid);const rules=readFeishuRules(db,pid).filter(rule=>rule.status==='enabled'&&rule.enabledAt&&event.createdAt>=rule.enabledAt&&eventMatches(event,rule)&&source.sequence>((db.prepare('SELECT event_watermark FROM feishu_rule_activation WHERE project_id=? AND rule_id=? AND rule_version=?').get(pid,rule.id,rule.version) as {event_watermark:number}|undefined)?.event_watermark??0));
  for(const bot of readFeishuBots(db,pid).filter(bot=>bot.enabled&&bot.testedAt&&bot.confirmedAt)){
   const matched=rules.filter(rule=>rule.botIds.includes(bot.id));if(!matched.length||db.prepare('SELECT 1 FROM feishu_event_targets WHERE project_id=? AND event_key=? AND bot_id=?').get(pid,event.key,bot.id))continue;
   // A single event is delivered once per bot even when multiple rules overlap.
   const immediate=matched.some(rule=>rule.deliveryMode==='immediate'),mergedRule={...matched[0]!,mentionAll:matched.some(rule=>rule.mentionAll),bypassQuiet:matched.every(rule=>rule.bypassQuiet)};
   const nominal=immediate?new Date(event.createdAt):new Date((Math.floor(Date.parse(event.createdAt)/(10*minute))+1)*10*minute),due=quietAdjusted(nominal,mergedRule,prefs);
   const bucket=`event:${bot.id}:${matched.map(rule=>`${rule.id}:${rule.version}`).sort().join(',')}:${immediate?event.key:due.toISOString()}`;
   const prior=db.prepare("SELECT d.status,json_array_length(json_extract(d.snapshot_json,'$.attempts')) AS attempt_count FROM background_jobs j JOIN feishu_deliveries d ON d.job_id=j.id WHERE j.project_id=? AND j.kind='feishu_delivery' AND j.dedupe_key=?").get(pid,bucket) as {status:string;attempt_count:number}|undefined;
   const finalBucket=prior&&(prior.status!=='pending'||prior.attempt_count>0)?`${bucket}:continuation:${rows[0]!.event_key}`:bucket;
   const row=insertDelivery(db,pid,bot,matched,'event',eventMessage(db,pid,mergedRule,[event],now,options.publicBaseUrl),due,now,finalBucket),{delivery,meta}=read(row);
   if(!meta.eventKeys.includes(event.key)&&row.status==='pending'){
    meta.eventKeys.push(event.key);const events=meta.eventKeys.map(key=>JSON.parse((db.prepare('SELECT snapshot_json FROM feishu_events WHERE project_id=? AND event_key=?').get(pid,key) as {snapshot_json:string}).snapshot_json) as FeishuEvent);delivery.message=eventMessage(db,pid,mergedRule,events,now,options.publicBaseUrl);save(db,row,delivery,meta);
   }
   db.prepare('INSERT INTO feishu_event_targets VALUES(?,?,?,?)').run(pid,event.key,bot.id,row.id);
  }
  db.prepare('UPDATE feishu_events SET processed=1 WHERE project_id=? AND event_key=?').run(pid,event.key);
 }
}
function schedule(db:Database.Database,now:Date,options:FeishuRuntimeOptions){
 for(const {id:pid} of db.prepare('SELECT id FROM homepage_projects').all() as {id:string}[])for(const rule of readFeishuRules(db,pid).filter(rule=>rule.status==='enabled'&&rule.enabledAt&&!rule.template.endsWith('_event'))){
  const prefs=readFeishuPreferences(db,pid);let cursor=db.prepare('SELECT * FROM feishu_rule_schedules WHERE project_id=? AND rule_id=?').get(pid,rule.id) as {rule_version:number;next_nominal_at:string;last_nominal_at:string|null}|undefined;
  if(!cursor||cursor.rule_version!==rule.version){const slot=nextSlot(db,pid,rule,new Date(rule.enabledAt!),prefs);if(!slot)continue;cursor={rule_version:rule.version,next_nominal_at:slot.nominal.toISOString(),last_nominal_at:null};db.prepare('INSERT INTO feishu_rule_schedules VALUES(?,?,?,?,?) ON CONFLICT(project_id,rule_id) DO UPDATE SET rule_version=excluded.rule_version,next_nominal_at=excluded.next_nominal_at,last_nominal_at=NULL').run(pid,rule.id,rule.version,cursor.next_nominal_at,null);}
  for(let i=0;i<32&&new Date(cursor.next_nominal_at)<=now;i++){
   const nominal=new Date(cursor.next_nominal_at),effective=quietAdjusted(nominal,rule,prefs);if(effective>now)break;
   const periodStart=cursor.last_nominal_at?new Date(cursor.last_nominal_at):initialPeriod(rule,nominal);
   for(const bot of readFeishuBots(db,pid).filter(bot=>rule.botIds.includes(bot.id)&&bot.enabled&&bot.testedAt&&bot.confirmedAt)){
    const missed=now.getTime()-effective.getTime()>30*minute,message=missed?{...baseMessage(db,pid,rule,now,options.publicBaseUrl),lines:['已错过发送窗口，未用当前数据补造历史报告。']}:buildFeishuMessage(db,pid,rule,now,options.publicBaseUrl,periodStart,nominal);
    const row=insertDelivery(db,pid,bot,[rule],'scheduled',message,effective,now,`scheduled:${rule.id}:${bot.id}:${nominal.toISOString()}`,{nominalAt:nominal.toISOString(),effectiveAt:effective.toISOString(),periodStart:periodStart.toISOString()});if(missed&&row.status==='pending')finish(db,row,'missed',now,'已错过有效发送时刻 30 分钟。');
   }
   const next=nextSlot(db,pid,rule,nominal,prefs);if(!next)break;cursor.last_nominal_at=nominal.toISOString();cursor.next_nominal_at=next.nominal.toISOString();db.prepare('UPDATE feishu_rule_schedules SET next_nominal_at=?,last_nominal_at=? WHERE project_id=? AND rule_id=?').run(cursor.next_nominal_at,cursor.last_nominal_at,pid,rule.id);
  }
 }
}
export function readFeishuDeliveryRecord(db:Database.Database,pid:string,id:string):FeishuDelivery|undefined {const row=db.prepare('SELECT * FROM feishu_deliveries WHERE project_id=? AND id=?').get(pid,id) as Row|undefined;return row?read(row).delivery:undefined;}
export function createFeishuRunner(db:Database.Database,options:FeishuRuntimeOptions={}) {
 const clock=options.clock??(()=>new Date()),transport=options.transport??fetch;let timer:ReturnType<typeof setInterval>|undefined,active:Promise<{processed:number}>|undefined,stopping=false;
 function claim(now:Date):{row:Row;lease:string;bot:FeishuBot;credentials:{webhook:string;secret:string}}|undefined {
  return db.transaction(()=>{
   const expired=db.prepare("SELECT d.* FROM feishu_deliveries d JOIN background_jobs j ON j.id=d.job_id WHERE d.status='sending' AND j.lease_until<=?").all(now.toISOString()) as Row[];
   for(const row of expired){const {delivery}=read(row);delivery.attempts.push({at:now.toISOString(),outcome:'unknown',message:'进程中断，原请求结果待核实。'});finish(db,row,'unknown',now,'发送租约过期，请人工核对目标群；不会自动重发。',delivery);if(delivery.kind==='test')markFeishuBotTest(db,row.project_id,row.bot_id,read(row).meta.botVersion,false,delivery.error,now);}
   const candidates=db.prepare("SELECT d.* FROM feishu_deliveries d JOIN background_jobs j ON j.id=d.job_id LEFT JOIN feishu_bot_rate r ON r.project_id=d.project_id AND r.bot_id=d.bot_id WHERE d.status='pending' AND j.status='pending' AND d.due_at<=? AND (r.next_send_at IS NULL OR r.next_send_at<=?) ORDER BY d.due_at,d.id LIMIT 40").all(now.toISOString(),now.toISOString()) as Row[];
   for(const row of candidates){const {delivery,meta}=read(row),pid=row.project_id,bot=readFeishuBots(db,pid).find(bot=>bot.id===row.bot_id),rules=readFeishuRules(db,pid).filter(rule=>delivery.ruleIds.includes(rule.id));
    if(!bot||!bot.enabled||bot.version!==meta.botVersion||delivery.kind!=='test'&&(!bot.testedAt||!bot.confirmedAt||rules.length!==delivery.ruleIds.length||rules.some(rule=>rule.status!=='enabled'||rule.version!==meta.ruleVersions[rule.id]))){finish(db,row,'cancelled',now,'机器人或规则已改变，旧消息已取消。');continue;}
    if(delivery.kind==='scheduled'){
     const rule=rules[0]!;if(!nominalAllowed(db,pid,rule,new Date(meta.nominalAt!))){finish(db,row,'cancelled',now,'原定日期已不属于当前工作日或工作日历未确认，投递已取消。');continue;}
     const effective=quietAdjusted(new Date(meta.nominalAt!),rule,readFeishuPreferences(db,pid));
     if(!meta.manualRetry&&now.getTime()-effective.getTime()>30*minute){finish(db,row,'missed',now,'已错过有效发送时刻 30 分钟。');continue;}
     if(!rule.template.endsWith('_report')) {
      const current=buildFeishuMessage(db,pid,rule,now,options.publicBaseUrl,new Date(meta.periodStart!),new Date(meta.nominalAt!));
      const snapshot=(message:FeishuMessage)=>{const {generatedAt:_generated,...content}=message;return JSON.stringify(content);};
      if(meta.manualRetry&&snapshot(current)!==snapshot(delivery.message)){finish(db,row,'cancelled',now,'提醒条件或内容已变化，未重发旧预览；请预览最新规则并等待下一次通知。');continue;}
      if(!meta.manualRetry)delivery.message=current;
     }
     if(!delivery.message.total&&(!rule.template.endsWith('_report')||rule.skipEmpty)){finish(db,row,'skipped',now,'发送前复核：已没有符合提醒条件的事项。',delivery);continue;}
    }
    if(delivery.kind==='event'){
     const events=meta.eventKeys.map(key=>db.prepare('SELECT snapshot_json FROM feishu_events WHERE project_id=? AND event_key=?').get(pid,key) as {snapshot_json:string}|undefined).filter((row):row is {snapshot_json:string}=>Boolean(row)).map(row=>JSON.parse(row.snapshot_json) as FeishuEvent);
     if(!events.length||!meta.manualRetry&&events.every(event=>now.getTime()-Date.parse(event.createdAt)>day)){finish(db,row,'skipped',now,'业务事件积压超过 24 小时，已跳过。');continue;}
     // Initial sends drop each expired event; retries retain the approved historical snapshot.
     if(!meta.manualRetry&&!delivery.attempts.length){const fresh=events.filter(event=>now.getTime()-Date.parse(event.createdAt)<=day);if(fresh.length!==events.length){delivery.message=eventMessage(db,pid,{...rules[0]!,mentionAll:rules.some(rule=>rule.mentionAll)},fresh,now,options.publicBaseUrl);delivery.audit.push({at:now.toISOString(),actor:'系统',action:`初次发送前跳过 ${events.length-fresh.length} 个超过 24 小时的业务事件`});}}
     // Event retries must not rewrite names or historical context.
    }
    if(delivery.kind!=='test'){
     const effective=quietAdjusted(now,{...rules[0]!,bypassQuiet:rules.every(rule=>rule.bypassQuiet)},readFeishuPreferences(db,pid));if(effective>now){delivery.dueAt=effective.toISOString();delivery.version++;save(db,row,delivery);db.prepare('UPDATE background_jobs SET due_at=? WHERE id=?').run(delivery.dueAt,row.job_id);continue;}
    }
    let credentials:{webhook:string;secret:string};try{credentials=readFeishuCredentials(db,pid,bot.id,runtimeFeishuKey(options));}catch{finish(db,row,'failed',now,'机器人凭据无法读取，请修复主密钥或重新配置。');continue;}
    const lease=randomUUID();db.prepare("UPDATE background_jobs SET status='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE id=? AND status='pending'").run(lease,new Date(now.getTime()+minute).toISOString(),row.job_id);
    db.prepare('INSERT INTO feishu_bot_rate VALUES(?,?,?) ON CONFLICT(project_id,bot_id) DO UPDATE SET next_send_at=excluded.next_send_at').run(pid,bot.id,new Date(now.getTime()+1000).toISOString());delivery.status='sending';delivery.version++;save(db,row,delivery);return {row,lease,bot,credentials};
   }
   return undefined;
  }).immediate();
 }
 async function execute(now:Date):Promise<{processed:number}> {
  if(!feishuMasterKeyAvailable(runtimeFeishuKey(options)))return {processed:0};
  db.transaction(()=>{materializeEvents(db,now,options);schedule(db,now,options);})();
  const claims:Array<NonNullable<ReturnType<typeof claim>>>=[];for(let i=0;i<4;i++){const next=claim(now);if(!next)break;claims.push(next);}
  await Promise.all(claims.map(async item=>{
   // No transaction spans the network boundary. A persisted lease precedes every request.
   const outcome=await deliverFeishuMessage(item.credentials,item.bot,read(item.row).delivery.message,transport,now),finished=new Date(Math.max(now.getTime(),clock().getTime()));
   db.transaction(()=>{
    const job=db.prepare('SELECT status,lease_token,attempts FROM background_jobs WHERE id=?').get(item.row.job_id) as {status:string;lease_token:string;attempts:number}|undefined;if(job?.status!=='running'||job.lease_token!==item.lease)return;
    const row=db.prepare('SELECT * FROM feishu_deliveries WHERE id=?').get(item.row.id) as Row,{delivery,meta}=read(row);delivery.attempts.push({at:finished.toISOString(),outcome:outcome.outcome,message:outcome.message});
    if(outcome.outcome==='failed'&&outcome.retryable&&job.attempts<4){delivery.status='pending';delivery.dueAt=new Date(finished.getTime()+[1,5,15][job.attempts-1]!*minute).toISOString();delivery.error=outcome.message;delivery.version++;save(db,row,delivery);db.prepare("UPDATE background_jobs SET status='pending',due_at=?,error=?,lease_token=NULL,lease_until=NULL WHERE id=?").run(delivery.dueAt,delivery.error,row.job_id);}else finish(db,row,outcome.outcome,finished,outcome.outcome==='accepted'?null:outcome.message,delivery);
    if(delivery.kind==='test')markFeishuBotTest(db,row.project_id,row.bot_id,meta.botVersion,outcome.outcome==='accepted',outcome.outcome==='accepted'?null:outcome.message,finished);
   })();
  }));return {processed:claims.length};
 }
 function runDueJobs(now=clock()):Promise<{processed:number}>{if(active)return active;if(stopping)return Promise.resolve({processed:0});active=execute(now).finally(()=>{active=undefined;});return active;}
 return {runDueJobs,start(){if(timer)return;stopping=false;timer=setInterval(()=>{void runDueJobs().catch(()=>{/* Durable records retain recovery context; never log credentials. */});},options.intervalMs??1000);timer.unref();},async stop(){stopping=true;if(timer)clearInterval(timer);timer=undefined;await active;}};
}
