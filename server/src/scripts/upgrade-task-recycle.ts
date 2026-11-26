import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { validateExistingDatabase } from '../db/existing.js';
import { migrateTaskRecycle } from '../modules/tasks/recycle-store.js';

const args=process.argv.slice(2),apply=args.includes('--apply');
const path=args.find(a=>!a.startsWith('--'));
if(!path || args.some(a=>a.startsWith('--')&&a!=='--apply'))throw new Error('用法：tsx server/src/scripts/upgrade-task-recycle.ts <数据库路径> [--apply]；请先停止应用。默认仅检查。');
const db=new Database(resolve(path),{fileMustExist:true,readonly:!apply});
try {
  validateExistingDatabase(db,true);
  if(!apply)console.log('数据库兼容，可显式执行 --apply 升级。');
  else {
    const backup=`${resolve(path)}.before-task-recycle-${Date.now()}.sqlite`;
    await db.backup(backup);
    db.pragma('foreign_keys=ON');db.pragma('busy_timeout=5000');
    db.transaction(()=>{migrateTaskRecycle(db);validateExistingDatabase(db);}).immediate();
    console.log(`回收站增量迁移完成；业务数据未重建。备份：${backup}`);
  }
} finally {db.close();}
