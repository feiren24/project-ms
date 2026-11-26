import { isExistingDatabase } from '../../db/lifecycle.js';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { FeishuBot, NotificationRule, NotificationPreferences } from '../../../../shared/src/feishu.js';
import { PlanError } from '../planning/errors.js';
export const defaultFeishuPreferences:NotificationPreferences={version:1,quietEnabled:true,quietStart:'20:00',quietEnd:'09:00',timezone:'Asia/Shanghai'};
export function initializeFeishu(db:Database.Database) {
  if (isExistingDatabase(db)) return;
 db.exec(`CREATE TABLE IF NOT EXISTS feishu_projects(project_id TEXT PRIMARY KEY REFERENCES homepage_projects(id),version INTEGER NOT NULL,preferences_json TEXT NOT NULL CHECK(json_valid(preferences_json)));
 CREATE TABLE IF NOT EXISTS feishu_bots(project_id TEXT NOT NULL REFERENCES homepage_projects(id),id TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),credentials_json TEXT NOT NULL,PRIMARY KEY(project_id,id));
 CREATE TABLE IF NOT EXISTS feishu_rules(project_id TEXT NOT NULL REFERENCES homepage_projects(id),id TEXT NOT NULL,snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),PRIMARY KEY(project_id,id));
 CREATE TABLE IF NOT EXISTS feishu_audit(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES homepage_projects(id),at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS feishu_audit_project ON feishu_audit(project_id,at);
 CREATE TABLE IF NOT EXISTS feishu_receipts(project_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(project_id,request_key));`);
}
function masterKey(value?:string):Buffer {
 if(!value || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new PlanError(503,'FEISHU_KEY_UNAVAILABLE','飞书凭据加密未配置，请配置服务端 FEISHU_MASTER_KEY（32字节 Base64）。');
 const key=Buffer.from(value,'base64');
 if(key.length!==32 || key.toString('base64')!==value) throw new PlanError(503,'FEISHU_KEY_UNAVAILABLE','飞书凭据加密配置无效，请联系系统管理员。');
 return key;
}
export function feishuMasterKeyAvailable(value?:string) {try{masterKey(value);return true;}catch{return false;}}
export function validFeishuWebhook(value:unknown):value is string {
 if(typeof value!=='string' || value.length>300) return false;
 return /^https:\/\/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9_-]{8,128}$/.test(value);
}
export function normalizedFeishuBaseUrl(value?:string):string|null {
 if(!value)return null;
 try{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||['localhost','127.0.0.1','[::1]'].includes(url.hostname))return null;return url.toString().replace(/\/$/,'');}catch{return null;}
}
export function encryptFeishuCredentials(value:{webhook:string;secret:string},key:string|undefined,projectId:string,botId:string):string {
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',masterKey(key),iv);cipher.setAAD(Buffer.from(JSON.stringify([projectId,botId])));
 const data=Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
 return JSON.stringify({version:1,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')});
}
export function decryptFeishuCredentials(value:string,key:string|undefined,projectId:string,botId:string):{webhook:string;secret:string} {
 const material=masterKey(key);
 try{
  const sealed=JSON.parse(value);if(sealed.version!==1)throw new Error('format');
  const decipher=createDecipheriv('aes-256-gcm',material,Buffer.from(sealed.iv,'base64'));decipher.setAAD(Buffer.from(JSON.stringify([projectId,botId])));decipher.setAuthTag(Buffer.from(sealed.tag,'base64'));
  const result=JSON.parse(Buffer.concat([decipher.update(Buffer.from(sealed.data,'base64')),decipher.final()]).toString('utf8'));
  if(!validFeishuWebhook(result.webhook)||typeof result.secret!=='string')throw new Error('format');return result;
 }catch{throw new PlanError(503,'FEISHU_CREDENTIAL_UNAVAILABLE','机器人凭据无法解密，请恢复原主密钥或重新填写机器人凭据。');}
}
export function readFeishuBots(db:Database.Database,pid:string):FeishuBot[]{return(db.prepare('SELECT snapshot_json FROM feishu_bots WHERE project_id=? ORDER BY rowid').all(pid) as {snapshot_json:string}[]).map(r=>JSON.parse(r.snapshot_json));}
export function readFeishuRules(db:Database.Database,pid:string):NotificationRule[]{return(db.prepare('SELECT snapshot_json FROM feishu_rules WHERE project_id=? ORDER BY rowid').all(pid) as {snapshot_json:string}[]).map(r=>JSON.parse(r.snapshot_json));}
export function readFeishuPreferences(db:Database.Database,pid:string):NotificationPreferences{const row=db.prepare('SELECT preferences_json FROM feishu_projects WHERE project_id=?').get(pid) as {preferences_json:string}|undefined;return row?JSON.parse(row.preferences_json):{...defaultFeishuPreferences};}
export function readFeishuVersion(db:Database.Database,pid:string):number{return(db.prepare('SELECT version FROM feishu_projects WHERE project_id=?').get(pid) as {version:number}|undefined)?.version??1;}
export function bumpFeishuVersion(db:Database.Database,pid:string){db.prepare('INSERT INTO feishu_projects VALUES(?,2,?) ON CONFLICT(project_id) DO UPDATE SET version=version+1').run(pid,JSON.stringify(defaultFeishuPreferences));}
export function saveFeishuRule(db:Database.Database,pid:string,rule:NotificationRule){db.prepare('INSERT INTO feishu_rules VALUES(?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(pid,rule.id,JSON.stringify(rule));}
export function saveFeishuBot(db:Database.Database,pid:string,bot:FeishuBot,credentials?:string){if(credentials!==undefined)db.prepare('INSERT INTO feishu_bots VALUES(?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET snapshot_json=excluded.snapshot_json,credentials_json=excluded.credentials_json').run(pid,bot.id,JSON.stringify(bot),credentials);else db.prepare('UPDATE feishu_bots SET snapshot_json=? WHERE project_id=? AND id=?').run(JSON.stringify(bot),pid,bot.id);}
export function readFeishuCredentials(db:Database.Database,pid:string,id:string,key?:string){const row=db.prepare('SELECT credentials_json FROM feishu_bots WHERE project_id=? AND id=?').get(pid,id) as {credentials_json:string}|undefined;if(!row)throw new PlanError(404,'BOT_NOT_FOUND','机器人不存在。');return decryptFeishuCredentials(row.credentials_json,key,pid,id);}
export function markFeishuBotTest(db:Database.Database,pid:string,id:string,version:number,accepted:boolean,message:string|null,now:Date){const bot=readFeishuBots(db,pid).find(b=>b.id===id);if(!bot||bot.version!==version)return;saveFeishuBot(db,pid,{...bot,testedAt:accepted?now.toISOString():null,lastError:message});}
export function recordFeishuAudit(db:Database.Database,pid:string,actor:string,action:string,now:Date){db.prepare('INSERT INTO feishu_audit VALUES(?,?,?,?,?)').run(randomUUID(),pid,now.toISOString(),actor,action);}
