import { readFileSync, statSync } from 'node:fs';
import Database from 'better-sqlite3';
import { readSchema, schemaDifferences, type SchemaContract } from './schema.js';

const contract = () => JSON.parse(readFileSync(new URL('./schema-contract.json', import.meta.url), 'utf8')) as SchemaContract;
export function validateExistingDatabase(db: Database.Database, beforeRecycleUpgrade = false) {
  if (db.pragma('quick_check', {simple:true}) !== 'ok') throw new Error('SQLite 完整性检查失败，未修改数据库。');
  const expected=contract();
  if(beforeRecycleUpgrade){expected.objects=expected.objects.filter(o=>!o.name.startsWith('task_recycle'));delete expected.migrations.task_recycle_schema_migrations;}
  const differences = schemaDifferences(readSchema(db), expected);
  if (differences.length) throw new Error(`已有数据库与当前代码不兼容，禁止自动迁移：\n${differences.join('\n')}`);
  for (const [table, predicate] of [
    ['system_settings_config','id=1'], ['activity_config','id=1'], ['activity_backfill','id=1'],
    ['notification_state',"key='initial_events_seen'"], ['feishu_event_state',"key='initialized'"],
  ]) {
    if (!db.prepare(`SELECT 1 FROM ${table} WHERE ${predicate}`).get()) throw new Error(`缺少运行记录 ${table} (${predicate})，禁止自动补数据。`);
  }
}
export function checkExistingDatabase(path: string) {
  let stat;
  try { stat = statSync(path); } catch { throw new Error(`已有 SQLite 文件不存在：${path}。不会创建新库。`); }
  if (!stat.isFile() || !stat.size) throw new Error(`SQLite 文件为空或不是普通文件：${path}。不会初始化数据库。`);
  const db = new Database(path, {readonly:true, fileMustExist:true});
  try { validateExistingDatabase(db); } finally { db.close(); }
}
