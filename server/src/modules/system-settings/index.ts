import { isExistingDatabase } from '../../db/lifecycle.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { SaveFeishuKeyInput, SystemKeyBackup, SystemSettingsAudit, SystemSettingsStatus } from '../../../../shared/src/system-settings.js';
import { PlanError } from '../planning/errors.js';
import { decryptFeishuCredentials, encryptFeishuCredentials, feishuMasterKeyAvailable } from '../feishu/store.js';
import { readKeyFile, syncKeyFile, writeKeyFile, type KeyOperation } from './key-file.js';
export interface SystemSettingsProviderOptions {
  environmentKey?: string;
  clock?: () => Date;
  /** Internal isolation for tests; never accepted from HTTP requests. */
  keyDirectory?: string;
}
interface ConfigRow { version: number; updated_at: string | null; updated_by: string | null }
interface Receipt { request_hash: string }
export interface SystemSettingsIdentity { accountId: string; actor: string }
export interface SystemSettingsProvider {
  getKey(): string | undefined;
  readStatus(): SystemSettingsStatus;
  saveFeishuKey(input: unknown, requestKey: unknown, identity: SystemSettingsIdentity): SystemSettingsStatus;
  readAudit(page?: unknown): SystemSettingsAudit;
  backupFeishuKey(input: unknown, identity: SystemSettingsIdentity): SystemKeyBackup;
}
export interface SystemSettingsRouteAuth {
  protectWrite(request: FastifyRequest): Promise<void>;
  systemAdmin(request: FastifyRequest): boolean;
  accountId(request: FastifyRequest): string;
  actorName(request: FastifyRequest): string;
}
export function createSystemSettingsProvider(db: Database.Database, options: SystemSettingsProviderOptions = {}): SystemSettingsProvider {
  const clock = options.clock ?? (() => new Date());
  const directory = options.keyDirectory ?? (db.name && db.name !== ':memory:' ? join(dirname(db.name),'system-secrets') : undefined);
  const environmentDefined = options.environmentKey !== undefined;
  if (!isExistingDatabase(db)) db.exec(`CREATE TABLE IF NOT EXISTS system_settings_config(id INTEGER PRIMARY KEY CHECK(id=1),version INTEGER NOT NULL,updated_at TEXT,updated_by TEXT);
    INSERT OR IGNORE INTO system_settings_config VALUES(1,1,NULL,NULL);
    CREATE TABLE IF NOT EXISTS system_settings_audit(id TEXT PRIMARY KEY,at TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,result TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS system_settings_receipts(account_id TEXT NOT NULL,request_key TEXT NOT NULL,request_hash TEXT NOT NULL,PRIMARY KEY(account_id,request_key));`);
  const config = () => db.prepare('SELECT version,updated_at,updated_by FROM system_settings_config WHERE id=1').get() as ConfigRow;
  const credentials = () => db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feishu_bots'").get()
    ? db.prepare('SELECT project_id,id,credentials_json FROM feishu_bots').all() as {project_id:string;id:string;credentials_json:string}[] : [];
  const usable = (key: string | undefined) => {
    if (!feishuMasterKeyAvailable(key)) return false;
    try { for (const row of credentials()) decryptFeishuCredentials(row.credentials_json,key,row.project_id,row.id); return true; }
    catch { return false; }
  };
  const finalize = (op: KeyOperation) => {
    const existing = db.prepare('SELECT request_hash FROM system_settings_receipts WHERE account_id=? AND request_key=?').get(op.accountId,op.requestKey) as Receipt | undefined;
    if (existing || op.version !== config().version + 1) return;
    db.prepare('UPDATE system_settings_config SET version=?,updated_at=?,updated_by=? WHERE id=1').run(op.version,op.at,op.actor);
    db.prepare('INSERT INTO system_settings_audit VALUES(?,?,?,?,?)').run(op.id,op.at,op.actor,op.action,'成功');
    db.prepare('INSERT INTO system_settings_receipts VALUES(?,?,?)').run(op.accountId,op.requestKey,op.requestHash);
  };
  const migration = (oldKey: string, newKey: string) => credentials().map(row => ({
    ...row, encrypted: encryptFeishuCredentials(decryptFeishuCredentials(row.credentials_json,oldKey,row.project_id,row.id),newKey,row.project_id,row.id),
  }));
  const applyMigration = (rows: ReturnType<typeof migration>) => {
    if (!rows.length) return;
    const update = db.prepare('UPDATE feishu_bots SET credentials_json=? WHERE project_id=? AND id=?');
    for (const row of rows) update.run(row.encrypted,row.project_id,row.id);
  };
  // Never discard a recovery key from inside an outer transaction that could still roll back.
  const cleanup = () => {
    if (db.inTransaction) return;
    const saved = readKeyFile(directory);
    if (saved.state !== 'ready' || !saved.file.previousKey || saved.file.operation.version !== config().version) return;
    try {
      db.transaction(() => {
        const current = readKeyFile(directory);
        if (current.state !== 'ready' || !current.file.previousKey || current.file.operation.version !== config().version || !usable(current.file.key)) return;
        const {previousKey: _previous, ...committed} = current.file;
        writeKeyFile(directory!,committed);
      }).immediate();
    } catch { /* Committed new key remains usable; retain recovery material and retry cleanup on next read. */ }
  };
  const recoverable = (file: import('./key-file.js').KeyFile) => feishuMasterKeyAvailable(file.key) && usable(file.previousKey ?? file.key);
  const reconcile = () => {
    const saved = readKeyFile(directory);
    if (saved.state === 'ready' && recoverable(saved.file) && saved.file.operation.version === config().version + 1) {
      // The committed private file is the durable intent; SQLite serializes replay with bot writes.
      db.transaction(() => {
        const current = readKeyFile(directory);
        if (current.state !== 'ready' || current.file.operation.version !== config().version + 1 || !recoverable(current.file)) return;
        try { syncKeyFile(directory!); } catch { return; }
        if (current.file.previousKey) applyMigration(migration(current.file.previousKey,current.file.key));
        finalize(current.file.operation);
      }).immediate();
    }
    cleanup();
  };
  const getKey = () => {
    try {
      const candidate = environmentDefined ? options.environmentKey : (() => { const saved=readKeyFile(directory);return saved.state==='ready' && saved.file.operation.version <= config().version?saved.file.key:undefined; })();
      return usable(candidate) ? candidate : undefined;
    } catch { return undefined; }
  };
  const readStatus = (): SystemSettingsStatus => {
    reconcile();
    const metadata = config(), saved = environmentDefined ? undefined : readKeyFile(directory);
    const source = environmentDefined ? 'environment' : saved?.state === 'missing' ? 'none' : 'file';
    const candidate = environmentDefined ? options.environmentKey : saved?.state === 'ready' ? saved.file.key : undefined;
    const uncommitted = saved?.state === 'ready' && saved.file.operation.version > metadata.version;
    const pending = uncommitted && saved.file.operation.version === metadata.version + 1 && recoverable(saved.file);
    const state = !uncommitted && usable(candidate) ? 'ready' : source === 'none' ? 'missing' : 'invalid';
    const credentialCount = credentials().length, hasCredentials = credentialCount > 0;
    const writable = !environmentDefined && !!directory && !pending && state !== 'ready';
    let message: string | null = null;
    if (environmentDefined) message = state === 'ready' ? '环境变量已配置，页面仅供查看。' : '环境变量中的主密钥无效或无法解密已有凭据，请由部署管理员恢复；页面不可覆盖。';
    else if (pending) message = '主密钥保存尚待恢复，请检查服务器存储后刷新；恢复完成前不可再次配置。';
    else if (uncommitted) message = '主密钥文件与数据库版本不一致，请导入原主密钥核对恢复。';
    else if (!directory) message = '当前数据库未使用持久化文件，无法保存主密钥。';
    else if (state !== 'ready') message = hasCredentials ? '已有机器人凭据，请导入原主密钥恢复；系统会校验所有项目的凭据。' : state === 'invalid' ? '本地主密钥文件不可用，请检查存储权限，或重新配置。' : '尚未配置飞书凭据加密主密钥。';
    else message = '主密钥已自动保存在服务器，无需复制即可使用。可备份当前密钥，或安全更换并保留已有机器人配置。';
    return {version:metadata.version,state,source,canGenerate:writable&&!hasCredentials,canImport:writable,hasCredentials,credentialCount,canBackup:!environmentDefined&&state==='ready',canRotate:!environmentDefined&&state==='ready',updatedAt:metadata.updated_at,updatedBy:metadata.updated_by,message};
  };
  const validateInput = (value: unknown): SaveFeishuKeyInput => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new PlanError(422,'INVALID_BODY','配置内容无效。');
    const fields = value as Record<string,unknown>;
    if (Object.keys(fields).some(key=>!['expectedVersion','mode','key','confirmed'].includes(key)) || !Number.isSafeInteger(fields.expectedVersion) || (fields.expectedVersion as number)<1 || !['generate','import','rotate'].includes(fields.mode as string)) throw new PlanError(422,'INVALID_BODY','请核对配置方式与版本后重试。');
    if (fields.mode !== 'import' && Object.hasOwn(fields,'key')) throw new PlanError(422,'INVALID_BODY','自动生成不能同时提交主密钥。');
    if (fields.mode === 'import' && (typeof fields.key !== 'string' || !feishuMasterKeyAvailable(fields.key))) throw new PlanError(422,'INVALID_FEISHU_KEY','请输入有效的 32 字节 Base64 主密钥。');
    if (fields.mode === 'rotate' && fields.confirmed !== true) throw new PlanError(422,'CONFIRM_REQUIRED','请确认安全更换将影响全部项目，并保留旧数据库对应的密钥备份。');
    if (fields.mode !== 'rotate' && Object.hasOwn(fields,'confirmed')) throw new PlanError(422,'INVALID_BODY','配置内容无效。');
    return fields as unknown as SaveFeishuKeyInput;
  };
  const saveFeishuKey = (raw: unknown, requestKey: unknown, identity: SystemSettingsIdentity): SystemSettingsStatus => {
    const input = validateInput(raw);
    if (db.inTransaction) throw new PlanError(409,'SYSTEM_SETTINGS_TRANSACTION_REQUIRED','密钥配置必须作为独立操作提交，不能嵌套在其他事务内。');
    if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(requestKey)) throw new PlanError(422,'IDEMPOTENCY_KEY_REQUIRED','请提供有效的唯一操作标识后重试。');
    const requestHash = createHash('sha256').update(JSON.stringify(input.mode==='rotate'?[input.expectedVersion,input.mode,true]:[input.expectedVersion,input.mode,input.key??null])).digest('hex');
    reconcile();
    db.transaction(() => {
      const old = db.prepare('SELECT request_hash FROM system_settings_receipts WHERE account_id=? AND request_key=?').get(identity.accountId,requestKey) as Receipt|undefined;
      if (old) { if (old.request_hash !== requestHash) throw new PlanError(409,'IDEMPOTENCY_CONFLICT','此操作标识已用于其他配置，请刷新后重试。'); return; }
      const status = readStatus();
      const saved = readKeyFile(directory);
      if (!environmentDefined && saved.state === 'ready' && saved.file.operation.version === status.version + 1 && recoverable(saved.file)) throw new PlanError(503,'SYSTEM_SETTINGS_STORAGE_UNAVAILABLE','主密钥保存尚待恢复，请检查服务器存储后刷新重试。');
      if (input.expectedVersion !== status.version) throw new PlanError(409,'SYSTEM_SETTINGS_VERSION_CONFLICT','系统设置已更新，请刷新后重新核对。');
      if (environmentDefined || (status.state === 'ready' && input.mode !== 'rotate')) throw new PlanError(409,'FEISHU_KEY_READ_ONLY','主密钥已配置或由环境变量管理，不能在此覆盖、更换或删除。');
      if (!directory) throw new PlanError(503,'SYSTEM_SETTINGS_STORAGE_UNAVAILABLE','当前配置存储不可用，请使用持久化数据库后重试。');
      if (input.mode === 'generate' && status.hasCredentials) throw new PlanError(409,'FEISHU_KEY_RESTORE_REQUIRED','已有机器人凭据，必须导入原主密钥恢复。');
      if (input.mode === 'rotate' && !status.canRotate) throw new PlanError(409,'FEISHU_KEY_RESTORE_REQUIRED','当前主密钥不可用，请先恢复原主密钥再安全更换。');
      const previousKey = input.mode === 'rotate' ? getKey()! : undefined;
      if (input.mode === 'rotate' && !previousKey) throw new PlanError(503,'FEISHU_KEY_UNAVAILABLE','主密钥不可用，请刷新后重试。');
      const key = input.mode !== 'import' ? randomBytes(32).toString('base64') : input.key!;
      const migrated = previousKey ? migration(previousKey,key) : [];
      if (input.mode !== 'rotate' && !usable(key)) throw new PlanError(422,'FEISHU_KEY_MISMATCH','此主密钥无法解密所有项目的机器人凭据，请核对原主密钥后重试。');
      const operation: KeyOperation = {id:randomUUID(),accountId:identity.accountId,requestKey,requestHash,version:status.version+1,at:clock().toISOString(),actor:identity.actor,action:input.mode==='rotate'?'安全更换飞书凭据主密钥':input.mode==='generate'?'生成飞书凭据主密钥':status.hasCredentials?'恢复飞书凭据主密钥':'导入飞书凭据主密钥'};
      try { writeKeyFile(directory,{format:1,key,operation,...(previousKey?{previousKey}:{})}); }
      catch { throw new PlanError(503,'SYSTEM_SETTINGS_STORAGE_UNAVAILABLE','主密钥未能可靠保存，请检查服务器存储与权限后刷新重试。'); }
      // A crash/SQLite commit failure is repaired from the committed file's receipt, exactly once.
      applyMigration(migrated);
      finalize(operation);
    }).immediate();
    return readStatus();
  };
  const backupFeishuKey = (input: unknown, identity: SystemSettingsIdentity): SystemKeyBackup => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PlanError(422,'INVALID_BODY','请确认备份配置。');
    const fields = input as Record<string,unknown>;
    if (Object.keys(fields).some(key=>!['expectedVersion','confirmed'].includes(key)) || fields.confirmed !== true || !Number.isSafeInteger(fields.expectedVersion) || (fields.expectedVersion as number)<1) throw new PlanError(422,'CONFIRM_REQUIRED','请核对版本并确认下载当前主密钥。');
    reconcile();
    return db.transaction(() => {
      const status = readStatus();
      if (fields.expectedVersion !== status.version) throw new PlanError(409,'SYSTEM_SETTINGS_VERSION_CONFLICT','系统设置已更新，请刷新后重新核对。');
      if (environmentDefined) throw new PlanError(409,'FEISHU_KEY_READ_ONLY','主密钥由环境变量管理，请通过部署渠道备份。');
      if (!status.canBackup) throw new PlanError(409,'FEISHU_KEY_RESTORE_REQUIRED','当前主密钥不可用，请先恢复原主密钥。');
      const key=getKey();
      if (!key) throw new PlanError(503,'FEISHU_KEY_UNAVAILABLE','主密钥不可用，请刷新后重试。');
      const exportedAt=clock().toISOString();
      db.prepare('INSERT INTO system_settings_audit VALUES(?,?,?,?,?)').run(randomUUID(),exportedAt,identity.actor,'备份飞书凭据主密钥','已生成备份下载');
      return {key,version:status.version,exportedAt};
    }).immediate();
  };
  const readAudit = (page: unknown = 1): SystemSettingsAudit => {
    const value = typeof page==='string' && /^[1-9]\d*$/.test(page) ? Number(page) : page;
    if (!Number.isSafeInteger(value) || (value as number)<1 || (value as number)>1000000) throw new PlanError(422,'INVALID_PAGE','审计页码无效。');
    reconcile();
    return {items:db.prepare('SELECT id,at,actor,action,result FROM system_settings_audit ORDER BY at DESC,rowid DESC LIMIT 20 OFFSET ?').all(((value as number)-1)*20) as SystemSettingsAudit['items'],page:value as number,total:(db.prepare('SELECT COUNT(*) AS total FROM system_settings_audit').get() as {total:number}).total};
  };
  reconcile();
  return {getKey,readStatus,saveFeishuKey,readAudit,backupFeishuKey};
}
export function registerSystemSettingsRoutes(app: FastifyInstance, provider: SystemSettingsProvider, auth: SystemSettingsRouteAuth) {
  const admin = (request: FastifyRequest) => { if (!auth.systemAdmin(request)) throw new PlanError(403,'ADMIN_REQUIRED','仅系统管理员可以管理系统设置。'); };
  app.get('/api/v1/admin/settings',(request,reply)=>{ admin(request);reply.header('Cache-Control','no-store');return {data:provider.readStatus()}; });
  app.get('/api/v1/admin/settings/audit',(request,reply)=>{ admin(request);reply.header('Cache-Control','no-store');return {data:provider.readAudit((request.query as {page?:string}).page)}; });
  app.post('/api/v1/admin/settings/feishu-key/backup',{bodyLimit:4096,preHandler:async request=>{admin(request);await auth.protectWrite(request);}},(request,reply)=>{
    admin(request);reply.header('Cache-Control','no-store');reply.header('Pragma','no-cache');
    return {data:provider.backupFeishuKey(request.body,{accountId:auth.accountId(request),actor:auth.actorName(request)})};
  });
  app.post('/api/v1/admin/settings/feishu-key',{bodyLimit:4096,preHandler:async request=>{admin(request);await auth.protectWrite(request);}},(request,reply)=>{
    admin(request);reply.header('Cache-Control','no-store');return {data:provider.saveFeishuKey(request.body,request.headers['idempotency-key'],{accountId:auth.accountId(request),actor:auth.actorName(request)})};
  });
}
