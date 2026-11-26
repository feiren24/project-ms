import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export interface KeyOperation {
  id: string; accountId: string; requestKey: string; requestHash: string;
  version: number; at: string; actor: string; action: string;
}
export interface KeyFile { format: 1; key: string; operation: KeyOperation; previousKey?: string }
export type FileRead = { state: 'missing' | 'invalid'; file?: never } | { state: 'ready'; file: KeyFile };
function directoryIdentity(path: string) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error('unsafe key directory');
  return info;
}
function sameDirectory(path: string, expected: NonNullable<ReturnType<typeof lstatSync>>) {
  const current = directoryIdentity(path);
  if (current.dev !== expected.dev || current.ino !== expected.ino) throw new Error('key directory changed');
}
function validOperation(value: unknown): value is KeyOperation {
  if (!value || typeof value !== 'object') return false;
  const op = value as KeyOperation;
  return ['id','accountId','requestKey','requestHash','at','actor','action'].every(field => typeof (op as unknown as Record<string,unknown>)[field] === 'string')
    && /^[a-f0-9]{64}$/.test(op.requestHash) && Number.isSafeInteger(op.version) && op.version >= 2 && Number.isFinite(Date.parse(op.at));
}
/** Reads never create directories and reject links, broad permissions and oversized files. */
export function readKeyFile(directory?: string): FileRead {
  if (!directory) return { state: 'missing' };
  let fd: number | undefined;
  try {
    const identity = directoryIdentity(directory);
    const path = join(directory,'feishu-master-key.json');
    try { fd = openSync(path,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {state:'missing'}; throw error; }
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 16384) return { state: 'invalid' };
    const value = JSON.parse(readFileSync(fd,'utf8')) as KeyFile;
    sameDirectory(directory,identity);
    if (value.format !== 1 || typeof value.key !== 'string' || (value.previousKey !== undefined && (typeof value.previousKey !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value.previousKey) || value.operation?.action !== '安全更换飞书凭据主密钥')) || !validOperation(value.operation)) return {state:'invalid'};
    return {state:'ready',file:value};
  } catch (error) {
    return {state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid'};
  } finally { if (fd !== undefined) closeSync(fd); }
}
/** A committed file carries the receipt needed to repair SQLite after a process crash. */
export function writeKeyFile(directory: string, file: KeyFile) {
  if (!existsSync(directory)) mkdirSync(directory,{mode:0o700});
  const identity = directoryIdentity(directory);
  const target = join(directory,'feishu-master-key.json');
  try { if (lstatSync(target).isSymbolicLink()) throw new Error('unsafe key file'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const temporary = join(directory,`.feishu-master-key-${randomUUID()}.tmp`);
  let fd: number | undefined; let directoryFd: number | undefined;
  try {
    directoryFd = openSync(directory,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(directoryFd);
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) throw new Error('key directory changed');
    fd = openSync(temporary,constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,0o600);
    writeFileSync(fd,JSON.stringify(file),'utf8'); fsyncSync(fd); closeSync(fd); fd=undefined;
    sameDirectory(directory,identity);
    try { if (lstatSync(target).isSymbolicLink()) throw new Error('unsafe key file'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    renameSync(temporary,target); fsyncSync(directoryFd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (directoryFd !== undefined) closeSync(directoryFd);
    try { unlinkSync(temporary); } catch { /* A renamed or failed temporary has no further action. */ }
  }
}

/** Re-establish durability when a previous process stopped between rename and directory fsync. */
export function syncKeyFile(directory: string) {
  const identity = directoryIdentity(directory);
  let fileFd: number | undefined; let directoryFd: number | undefined;
  try {
    directoryFd = openSync(directory,constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(directoryFd);
    if (opened.dev !== identity.dev || opened.ino !== identity.ino) throw new Error('key directory changed');
    fileFd = openSync(join(directory,'feishu-master-key.json'),constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = fstatSync(fileFd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) throw new Error('unsafe key file');
    fsyncSync(fileFd); sameDirectory(directory,identity); fsyncSync(directoryFd);
  } finally {
    if (fileFd !== undefined) closeSync(fileFd);
    if (directoryFd !== undefined) closeSync(directoryFd);
  }
}
