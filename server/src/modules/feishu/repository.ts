import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { feishuTemplates, type FeishuBot, type NotificationRule, type FeishuWorkspace, type FeishuRuleDraft, type FeishuDeliveryFilter } from '../../../../shared/src/feishu.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { readActors } from '../settings/store.js';
import { readProjectSnapshot } from '../projects/context.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { botDraft, ruleDraft, object, validTime } from './validation.js';
import { bumpFeishuVersion, encryptFeishuCredentials, feishuMasterKeyAvailable, normalizedFeishuBaseUrl, readFeishuBots, readFeishuRules, readFeishuCredentials, readFeishuPreferences, readFeishuVersion, recordFeishuAudit, saveFeishuBot, saveFeishuRule } from './store.js';
import { runtimeFeishuKey, activateFeishuRule, cancelFeishuPending, enqueueFeishuTest, readFeishuDeliveryRecord, listFeishuDeliveries, manageFeishuDelivery, nextFeishuRun, previewFeishuRule, type FeishuRuntimeOptions } from './engine.js';
export function requireFeishuManager(db:Database.Database,pid:string,actorId:unknown) {
 const snapshot=readProjectSnapshot(db,pid);if(!snapshot)throw new PlanError(404,'PROJECT_NOT_FOUND','未找到项目。');
 const actors=readActors(db,pid),actor=actors.find(a=>a.id===actorId);
 if(!actor||!isProjectManager(actor.role))throw new PlanError(403,'FEISHU_MANAGER_REQUIRED','仅项目负责人或管理员可以管理飞书通知。');
 return {snapshot,actor,actors};
}
export function readFeishuWorkspace(db:Database.Database,pid:string,actorId:unknown,token:string,options:FeishuRuntimeOptions,now:Date):FeishuWorkspace {
 const {snapshot,actors}=requireFeishuManager(db,pid,actorId);
 const calendar=db.prepare('SELECT calendar_json FROM plan_projects WHERE project_id=?').get(pid) as {calendar_json:string};
 const rules=readFeishuRules(db,pid).map(rule=>({...rule,nextRunAt:rule.status==='enabled'?nextFeishuRun(db,pid,rule,now):null}));
 const available=feishuMasterKeyAvailable(runtimeFeishuKey(options));
 return {project:{id:pid,name:snapshot.project.name,isDemo:snapshot.project.isDemo},version:readFeishuVersion(db,pid),writeToken:token,available,unavailableReason:available?null:'请由系统管理员在“系统设置”配置或恢复飞书主密钥，配置前不能接入或发送飞书通知。',publicBaseUrl:normalizedFeishuBaseUrl(options.publicBaseUrl),bots:readFeishuBots(db,pid),rules,preferences:readFeishuPreferences(db,pid),templates:feishuTemplates,actors,workstreams:snapshot.workstreams.map(w=>({id:w.id,name:w.name})),calendarConfirmed:JSON.parse(calendar.calendar_json).confirmed===true,audit:db.prepare('SELECT id,at,actor,action FROM feishu_audit WHERE project_id=? ORDER BY at DESC,rowid DESC LIMIT 100').all(pid) as FeishuWorkspace['audit']};
}
function enabledRuleChecks(db:Database.Database,pid:string,rule:FeishuRuleDraft,options:FeishuRuntimeOptions){
 requireValue(feishuMasterKeyAvailable(runtimeFeishuKey(options)),'FEISHU_UNAVAILABLE','飞书凭据加密未配置，请联系系统管理员。');
 requireValue(rule.botIds.length>0,'BOT_REQUIRED','请至少选择一个目标机器人。');
 const bots=readFeishuBots(db,pid);
 requireValue(rule.botIds.every(id=>bots.some(b=>b.id===id&&b.enabled&&b.testedAt&&b.confirmedAt)),'BOT_NOT_READY','所选机器人须启用、测试成功并核对目标群后，才可启用规则。');
 if(rule.schedule.mode==='workdays'&&feishuTemplates.find(t=>t.id===rule.template)?.category!=='event'){
  const row=db.prepare('SELECT calendar_json FROM plan_projects WHERE project_id=?').get(pid) as {calendar_json:string};
  requireValue(JSON.parse(row.calendar_json).confirmed===true,'CALENDAR_NOT_CONFIRMED','请先确认项目工作日历，或选择每周固定日期。');
 }
}
function validBots(db:Database.Database,pid:string,rule:FeishuRuleDraft){requireValue(rule.botIds.every(id=>readFeishuBots(db,pid).some(b=>b.id===id)),'INVALID_BOT','目标机器人不属于当前项目。');}
function pauseBotRules(db:Database.Database,pid:string,botId:string,now:Date){
 for(const rule of readFeishuRules(db,pid).filter(r=>r.status==='enabled'&&r.botIds.includes(botId))){saveFeishuRule(db,pid,{...rule,status:'paused',version:rule.version+1,nextRunAt:null,updatedAt:now.toISOString()});cancelFeishuPending(db,pid,{ruleId:rule.id},now);}
 cancelFeishuPending(db,pid,{botId},now);
}
const operationNames:Record<string,string>={bot_save:'保存机器人',bot_test:'确认发送测试',bot_confirm:'核对目标群',bot_enable:'启用机器人',bot_pause:'暂停机器人',rule_save:'保存规则草稿',rule_enable:'启用通知规则',rule_pause:'暂停通知规则',rule_copy:'复制规则为草稿',rule_archive:'归档通知规则',preferences:'修改发送偏好',delivery_retry:'确认重发消息',delivery_received:'人工核对已收到'};
function auditOperation(db:Database.Database,pid:string,operation:string):string {const [kind,id]=operation.split(':');const label=operationNames[kind!]??'更新通知配置';if(!id)return label;const name=kind?.startsWith('bot_')?readFeishuBots(db,pid).find(b=>b.id===id)?.name:kind?.startsWith('rule_')?readFeishuRules(db,pid).find(r=>r.id===id)?.name:undefined;return `${label} · ${name??id}`;}
/** Receipts deliberately store only an operation marker, never request bodies or secrets. */
function mutation<T>(db:Database.Database,pid:string,actorId:unknown,key:unknown,operation:string,body:unknown,now:Date,version:'config'|'delivery',run:(fields:Record<string,unknown>,actor:string)=>T):T|undefined {
 object(body);requireValue(typeof key==='string'&&/^[\w:.-]{8,128}$/.test(key),'IDEMPOTENCY_KEY_REQUIRED','请提供有效的唯一操作标识。');
 return db.transaction(()=>{
  const {actor}=requireFeishuManager(db,pid,actorId);
  const hash=createHash('sha256').update(JSON.stringify({operation,body,actorId})).digest('hex');
  const old=db.prepare('SELECT request_hash FROM feishu_receipts WHERE project_id=? AND request_key=?').get(pid,key) as {request_hash:string}|undefined;
  if(old){if(old.request_hash!==hash)throw new PlanError(409,'IDEMPOTENCY_CONFLICT','操作标识已被其他内容使用，请刷新后重试。');return undefined;}
  requireValue(Number.isInteger(body.expectedVersion)&&(body.expectedVersion as number)>0,'VERSION_REQUIRED','请携带配置版本后重试。');
  if(version==='config'&&body.expectedVersion!==readFeishuVersion(db,pid))throw new PlanError(409,'FEISHU_VERSION_CONFLICT','通知设置已被更新，请刷新最新配置并保留草稿，重新核对。');
  const result=run(body,actor.name);
  if(version==='config')bumpFeishuVersion(db,pid);
  recordFeishuAudit(db,pid,actor.name,auditOperation(db,pid,operation),now);
  db.prepare('INSERT INTO feishu_receipts VALUES(?,?,?,?)').run(pid,key,hash,'{}');return result;
 })();
}
export function writeFeishuConfig(db:Database.Database,pid:string,operation:string,id:string|undefined,body:unknown,actorId:unknown,key:unknown,token:string,options:FeishuRuntimeOptions,now:Date):FeishuWorkspace {
 mutation(db,pid,actorId,key,`${operation}${id?`:${id}`:''}`,body,now,'config',(fields,actor)=>{
  if(operation==='bot_save'){
   object(fields,['expectedVersion','bot']);requireValue(feishuMasterKeyAvailable(runtimeFeishuKey(options)),'FEISHU_UNAVAILABLE','请先在系统设置配置飞书凭据加密主密钥。');
   const old=id?readFeishuBots(db,pid).find(b=>b.id===id):undefined;if(id&&!old)throw new PlanError(404,'BOT_NOT_FOUND','机器人不存在或不属于当前项目。');
   const draft=botDraft(fields.bot,!old);const botId=id??`fb-${randomUUID()}`;
   const credentials=draft.webhook&&(draft.secret!==undefined||!draft.signatureEnabled)?{webhook:draft.webhook,secret:draft.secret??''}:old?readFeishuCredentials(db,pid,botId,runtimeFeishuKey(options)):{webhook:draft.webhook!,secret:draft.secret??''};
   const webhook=draft.webhook??credentials.webhook,secret=draft.secret??credentials.secret;
   requireValue(!draft.signatureEnabled||secret.length>0,'SIGNATURE_REQUIRED','开启签名校验需要有效签名密钥。');
   const previous=old?readFeishuBots(db,pid).find(b=>b.id===botId):undefined;
   // Any edited credential requires a new test. Webhook or group-label edits require human group verification again.
   const connectionChanged=!old||draft.webhook!==undefined||draft.secret!==undefined||draft.signatureEnabled!==old.signatureEnabled||draft.keyword!==old.keyword;
   const groupChanged=!old||draft.webhook!==undefined||draft.groupName!==old.groupName;
   const bot:FeishuBot={id:botId,version:old?(connectionChanged||groupChanged?old.version+1:old.version):1,name:draft.name,groupName:draft.groupName,keyword:draft.keyword,signatureEnabled:draft.signatureEnabled,maskedWebhook:`https://open.feishu.cn/…/${webhook.slice(-4)}`,hasSecret:secret.length>0,enabled:old?.enabled??true,testedAt:connectionChanged?null:old?.testedAt??null,confirmedAt:groupChanged?null:old?.confirmedAt??null,lastError:connectionChanged?null:old?.lastError??null,createdAt:old?.createdAt??now.toISOString(),updatedAt:now.toISOString()};
   saveFeishuBot(db,pid,bot,encryptFeishuCredentials({webhook,secret},runtimeFeishuKey(options),pid,botId));
   if(previous&&(connectionChanged||groupChanged))pauseBotRules(db,pid,botId,now);
  }else if(operation.startsWith('bot_')){
   object(fields,['expectedVersion','confirmed']);requireValue(fields.confirmed===true,'CONFIRM_REQUIRED','请核对目标群并确认操作。');
   const bot=readFeishuBots(db,pid).find(b=>b.id===id);if(!bot)throw new PlanError(404,'BOT_NOT_FOUND','机器人不存在或不属于当前项目。');
   if(operation==='bot_test'){
    requireValue(feishuMasterKeyAvailable(runtimeFeishuKey(options)),'FEISHU_UNAVAILABLE','飞书凭据加密未配置。');readFeishuCredentials(db,pid,bot.id,runtimeFeishuKey(options));
    enqueueFeishuTest(db,pid,bot.id,actor,now);
   }else if(operation==='bot_confirm'){
    requireValue(bot.testedAt,'BOT_TEST_REQUIRED','请先发送测试消息并确认飞书接收成功。');
    saveFeishuBot(db,pid,{...bot,confirmedAt:now.toISOString(),updatedAt:now.toISOString()});
   }else if(operation==='bot_pause'||operation==='bot_enable'){
    const enabled=operation==='bot_enable';saveFeishuBot(db,pid,{...bot,enabled,version:bot.version+1,updatedAt:now.toISOString()});
    if(!enabled)pauseBotRules(db,pid,bot.id,now);
   }else throw new PlanError(404,'ACTION_NOT_FOUND','不支持的机器人操作。');
  }else if(operation==='rule_save'){
   object(fields,['expectedVersion','rule']);const draft=ruleDraft(db,pid,fields.rule);validBots(db,pid,draft);
   const old=id?readFeishuRules(db,pid).find(r=>r.id===id):undefined;if(id&&!old)throw new PlanError(404,'RULE_NOT_FOUND','规则不存在或不属于当前项目。');
   requireValue(old?.status!=='archived','RULE_ARCHIVED','已归档规则不能编辑，请复制为草稿。');
   // Editing produces a draft; the approved preview must be explicitly enabled again.
   const rule:NotificationRule={...draft,id:id??`fr-${randomUUID()}`,version:(old?.version??0)+1,status:'draft',enabledAt:null,nextRunAt:null,createdAt:old?.createdAt??now.toISOString(),updatedAt:now.toISOString()};
   saveFeishuRule(db,pid,rule);if(old)cancelFeishuPending(db,pid,{ruleId:old.id},now);
  }else if(operation.startsWith('rule_')){
   object(fields,['expectedVersion','confirmed']);requireValue(fields.confirmed===true,'CONFIRM_REQUIRED','请预览通知范围、目标群和发送安排后确认。');
   const rule=readFeishuRules(db,pid).find(r=>r.id===id);if(!rule)throw new PlanError(404,'RULE_NOT_FOUND','规则不存在或不属于当前项目。');
   if(operation==='rule_copy'){
    saveFeishuRule(db,pid,{...rule,id:`fr-${randomUUID()}`,name:`${rule.name.slice(0,94)} 副本`,version:1,status:'draft',enabledAt:null,nextRunAt:null,createdAt:now.toISOString(),updatedAt:now.toISOString()});
   }else{
    requireValue(rule.status!=='archived','RULE_ARCHIVED','已归档规则只能复制为草稿。');
    const status=operation==='rule_enable'?'enabled':operation==='rule_pause'?'paused':operation==='rule_archive'?'archived':undefined;
    requireValue(status,'INVALID_OPERATION','不支持的规则操作。');
    if(status==='enabled')enabledRuleChecks(db,pid,rule,options);
    if(status==='enabled'&&rule.status==='enabled')return;
    cancelFeishuPending(db,pid,{ruleId:rule.id},now);
    saveFeishuRule(db,pid,{...rule,status,version:rule.version+1,enabledAt:status==='enabled'?now.toISOString():rule.enabledAt,nextRunAt:status==='enabled'?nextFeishuRun(db,pid,rule,now):null,updatedAt:now.toISOString()});
    if(status==='enabled')activateFeishuRule(db,pid,rule.id,rule.version+1);
   }
  }else if(operation==='preferences'){
   object(fields,['expectedVersion','preferences','confirmed']);requireValue(fields.confirmed===true,'CONFIRM_REQUIRED','请确认发送偏好。');object(fields.preferences,['quietEnabled','quietStart','quietEnd']);
   const p=fields.preferences;requireValue(typeof p.quietEnabled==='boolean'&&validTime(p.quietStart)&&validTime(p.quietEnd)&&p.quietStart!==p.quietEnd,'INVALID_QUIET','免打扰时间须有效，开始和结束不能相同。');
   const preferences={...readFeishuPreferences(db,pid),version:readFeishuPreferences(db,pid).version+1,quietEnabled:p.quietEnabled,quietStart:p.quietStart,quietEnd:p.quietEnd};
   db.prepare('INSERT INTO feishu_projects VALUES(?,?,?) ON CONFLICT(project_id) DO UPDATE SET preferences_json=excluded.preferences_json').run(pid,readFeishuVersion(db,pid),JSON.stringify(preferences));
  }else throw new PlanError(404,'ACTION_NOT_FOUND','不支持的通知设置操作。');
 });
 return readFeishuWorkspace(db,pid,actorId,token,options,now);
}
export function previewFeishuConfig(db:Database.Database,pid:string,actorId:unknown,body:unknown,options:FeishuRuntimeOptions,now:Date){requireFeishuManager(db,pid,actorId);object(body,['rule']);return previewFeishuRule(db,pid,ruleDraft(db,pid,body.rule),options,now);}
export function readFeishuDeliveryList(db:Database.Database,pid:string,actorId:unknown,filter:FeishuDeliveryFilter,now:Date){requireFeishuManager(db,pid,actorId);return listFeishuDeliveries(db,pid,filter,now);}
export function readFeishuDelivery(db:Database.Database,pid:string,actorId:unknown,id:string,now:Date){requireFeishuManager(db,pid,actorId);const delivery=readFeishuDeliveryRecord(db,pid,id);if(!delivery)throw new PlanError(404,'DELIVERY_NOT_FOUND','发送记录不存在或不属于当前项目。');return delivery;}
export function writeFeishuDelivery(db:Database.Database,pid:string,actorId:unknown,id:string,action:'retry'|'received',body:unknown,key:unknown,now:Date){
 mutation(db,pid,actorId,key,`delivery_${action}:${id}`,body,now,'delivery',(fields,actor)=>{object(fields,['expectedVersion','confirmed']);requireValue(fields.confirmed===true,'CONFIRM_REQUIRED','请核对目标群和消息内容后确认。');manageFeishuDelivery(db,pid,id,action,fields.expectedVersion as number,actor,now);});
 return readFeishuDelivery(db,pid,actorId,id,now);
}
