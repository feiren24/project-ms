import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openHomepageDatabase } from '../../server/src/db/connection.js';
import { initializePlanning } from '../../server/src/modules/planning/repository.js';
import { initializeSettings } from '../../server/src/modules/settings/store.js';
import { initializeFeishu, encryptFeishuCredentials, decryptFeishuCredentials, validFeishuWebhook, feishuMasterKeyAvailable, readFeishuPreferences, readFeishuBots } from '../../server/src/modules/feishu/store.js';
const key=Buffer.alloc(32,7).toString('base64');
describe('Feishu encrypted configuration',()=>{
 let db:Database.Database;
 beforeEach(()=>{db=openHomepageDatabase(':memory:');initializePlanning(db);initializeSettings(db);initializeFeishu(db);});
 afterEach(()=>db.close());
 test('repeatable migration and reads do not advance plan version',()=>{
  const before=db.prepare('SELECT version FROM plan_projects').all();initializeFeishu(db);initializeFeishu(db);
  const changes=db.prepare('SELECT total_changes() AS n').get();
  expect(readFeishuBots(db,'phase-one')).toEqual([]);expect(readFeishuPreferences(db,'phase-one')).toMatchObject({quietStart:'20:00',quietEnd:'09:00',timezone:'Asia/Shanghai'});
  expect(db.prepare('SELECT total_changes() AS n').get()).toEqual(changes);expect(db.prepare('SELECT version FROM plan_projects').all()).toEqual(before);
 });
 test('authenticated credential encryption is project/bot scoped',()=>{
  const credentials={webhook:'https://open.feishu.cn/open-apis/bot/v2/hook/12345678-abcd-1234-abcd-123456789abc',secret:'test-signing-secret'};
  const sealed=encryptFeishuCredentials(credentials,key,'phase-one','bot-1');
  expect(sealed).not.toContain(credentials.secret);expect(sealed).not.toContain('open.feishu');
  expect(decryptFeishuCredentials(sealed,key,'phase-one','bot-1')).toEqual(credentials);
  expect(()=>decryptFeishuCredentials(sealed,key,'other','bot-1')).toThrow();
  expect(()=>decryptFeishuCredentials(sealed,Buffer.alloc(32,8).toString('base64'),'phase-one','bot-1')).toThrow();
  expect(()=>decryptFeishuCredentials(sealed.slice(0,-4)+'xxxx',key,'phase-one','bot-1')).toThrow();
 });
 test('rejects malformed/missing encryption keys',()=>{
  expect(feishuMasterKeyAvailable(key)).toBe(true);
  for(const bad of [undefined,'password','',Buffer.alloc(16).toString('base64')]) expect(feishuMasterKeyAvailable(bad)).toBe(false);
 });
 test('only official HTTPS webhook path is accepted',()=>{
  expect(validFeishuWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/12345678-abcd-1234-abcd-123456789abc')).toBe(true);
  for(const value of ['http://open.feishu.cn/open-apis/bot/v2/hook/a','https://evil.test/open-apis/bot/v2/hook/a','https://open.feishu.cn.evil.test/open-apis/bot/v2/hook/a','https://user@open.feishu.cn/open-apis/bot/v2/hook/a','https://open.feishu.cn:444/open-apis/bot/v2/hook/a','https://open.feishu.cn/open-apis/bot/v2/hook/a?x=1','https://open.feishu.cn/open-apis/bot/v2/hook/a#x','https://open.feishu.cn/open-apis/bot/v2/hook/../../a']) expect(validFeishuWebhook(value)).toBe(false);
 });
});
