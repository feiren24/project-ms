#!/usr/bin/env node
// This helper is mounted into /app/scripts of the selected image. Its schema
// validator and SQLite driver therefore always belong to that image, even when
// the deployment script itself is upgraded without rebuilding the application.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { validateExistingDatabase } from '../server/src/db/existing.ts';

const suffixes = ['', '-wal', '-journal', '-shm'];
const reserveBytes = 128n * 1024n * 1024n;

class SnapshotError extends Error {
  constructor(code, message, cause) {
    super(message, { cause }); this.name = 'SnapshotError'; this.code = code;
    if (cause?.code) this.detailCode = cause.code;
  }
}
function interrupted(signal) {
  if (signal?.aborted) throw new SnapshotError('CHECK_INTERRUPTED', '数据库副本校验已中断，未修改原库。');
}
function metadata(stat) {
  return ['dev', 'ino', 'size', 'mode', 'uid', 'gid', 'mtimeNs', 'ctimeNs']
    .map(key => String(stat[key])).join(':');
}
async function fileState(path, required, signal) {
  interrupted(signal);
  let stat;
  try { stat = await fs.lstat(path, { bigint: true }); }
  catch (error) {
    if (!required && error.code === 'ENOENT') return null;
    throw new SnapshotError('SOURCE_READ_FAILED', `无法读取原数据库文件 ${basename(path)}；请核对文件及挂载权限。`, error);
  }
  if (stat.isSymbolicLink()) throw new SnapshotError('SOURCE_SYMLINK', `拒绝符号链接：${basename(path)}。`);
  if (!stat.isFile() || (required && stat.size === 0n)) throw new SnapshotError('SOURCE_INVALID', `数据库文件为空或不是普通文件：${basename(path)}。`);
  let handle;
  try {
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await handle.stat({ bigint: true });
    if (metadata(stat) !== metadata(before)) throw new SnapshotError('SOURCE_CHANGED', '校验期间原数据库文件发生变化，请停止其他数据库访问进程后重试。');
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) { interrupted(signal); digest.update(chunk); }
    if (metadata(before) !== metadata(await handle.stat({ bigint: true }))) throw new SnapshotError('SOURCE_CHANGED', '读取期间原数据库文件发生变化，请停止其他数据库访问进程后重试。');
    return { metadata: metadata(before), bytes: before.size, hash: digest.digest('hex') };
  } catch (error) {
    if (error instanceof SnapshotError) throw error;
    throw new SnapshotError('SOURCE_READ_FAILED', `读取原数据库文件失败：${basename(path)}。`, error);
  } finally { await handle?.close(); }
}
async function sourceState(path, signal) {
  const state = new Map();
  for (const suffix of suffixes) state.set(suffix, await fileState(path + suffix, suffix === '', signal));
  return state;
}
function sameState(before, after) {
  for (const suffix of suffixes) {
    const left = before.get(suffix), right = after.get(suffix);
    if (Boolean(left) !== Boolean(right) || left?.metadata !== right?.metadata || left?.hash !== right?.hash) return false;
  }
  return true;
}
async function verifySource(path, before, signal) {
  let after;
  try { after = await sourceState(path, signal); }
  catch (error) {
    if (error.code === 'CHECK_INTERRUPTED') throw error;
    throw new SnapshotError('SOURCE_CHANGED', '校验期间原数据库文件或配套日志发生变化，请停止其他数据库访问进程后重试。', error);
  }
  if (!sameState(before, after)) throw new SnapshotError('SOURCE_CHANGED', '校验期间原数据库文件或配套日志发生变化，请停止其他数据库访问进程后重试。');
}

/** Check a stopped database using a private disposable copy. Never open source
 * with SQLite: even a readonly SQLite connection may create WAL/SHM files.
 * The optional AbortSignal is used by the CLI and cancellation regression tests.
 */
export async function checkDatabaseSnapshot(sourcePath, stagingRoot, { signal } = {}) {
  const source = resolve(sourcePath), root = resolve(stagingRoot);
  interrupted(signal);
  const before = await sourceState(source, signal);
  const totalBytes = [...before].filter(([suffix, state]) => suffix !== '-shm' && state).reduce((sum, [, state]) => sum + state.bytes, 0n);
  let stage, database, result, failure;
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new SnapshotError('STAGING_INVALID', '副本根目录必须是已存在的普通目录，不能为符号链接。');
    const space = await fs.statfs(root, { bigint: true });
    if (space.bavail * space.bsize < totalBytes * 2n + reserveBytes) throw new SnapshotError('STAGING_SPACE', '数据库副本空间不足：需要至少两倍主库及日志大小，另加 128 MiB 余量。');
    stage = await fs.mkdtemp(join(root, 'snapshot-')); await fs.chmod(stage, 0o700);
    const copy = join(stage, basename(source));
    for (const [suffix, state] of before) {
      if (!state || suffix === '-shm') continue;
      interrupted(signal);
      try { await fs.copyFile(source + suffix, copy + suffix, constants.COPYFILE_EXCL); }
      catch (error) { throw new SnapshotError('SNAPSHOT_COPY_FAILED', `复制数据库文件失败：${basename(source + suffix)}。`, error); }
      interrupted(signal);
      // Copies may inherit 0444 from the original. Only the disposable copies
      // need write access for WAL recovery and shared-memory reconstruction.
      await fs.chmod(copy + suffix, 0o600);
    }
    await verifySource(source, before, signal);
    for (const [suffix, state] of before) {
      if (!state || suffix === '-shm') continue;
      const copied = await fileState(copy + suffix, suffix === '', signal);
      if (copied.hash !== state.hash || copied.bytes !== state.bytes) throw new SnapshotError('SNAPSHOT_MISMATCH', '数据库副本与原文件不一致，已停止校验。');
    }
    interrupted(signal);
    try {
      database = new Database(copy, { fileMustExist: true });
      // This function only checks integrity/schema/markers. Do not import or
      // call the app/connection initializer against either source or snapshot.
      validateExistingDatabase(database);
    } catch (error) { throw new SnapshotError('SNAPSHOT_VALIDATION_FAILED', `数据库副本完整性或结构校验失败：${error.message}`, error); }
    finally { database?.close(); database = undefined; }
    await verifySource(source, before, signal);
    result = { schemaCheck: 'passed', sourceUnchanged: true, copiedFiles: [...before].filter(([suffix, state]) => suffix !== '-shm' && state).map(([suffix]) => basename(source) + suffix) };
  } catch (error) {
    failure = error instanceof SnapshotError ? error : new SnapshotError('SNAPSHOT_FAILED', `数据库副本校验失败：${error.message}`, error);
  } finally {
    database?.close();
    if (stage) {
      try { await fs.rm(stage, { recursive: true, force: true }); }
      catch (error) { failure = new SnapshotError('SNAPSHOT_CLEANUP_FAILED', `数据库副本清理失败；请清理本次目录 ${stage}。${failure ? `原错误：${failure.message}` : ''}`, error); }
    }
  }
  if (failure) throw failure;
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const controller = new AbortController(); let receivedSignal;
  const interrupt = signal => { receivedSignal = signal; controller.abort(); };
  const onInt = () => interrupt('SIGINT'), onTerm = () => interrupt('SIGTERM');
  process.once('SIGINT', onInt); process.once('SIGTERM', onTerm);
  try {
    if (process.argv.length !== 4) throw new SnapshotError('INVALID_ARGUMENTS', '用法：check-database-snapshot.mjs /source/已有.sqlite /check');
    const result = await checkDatabaseSnapshot(process.argv[2], process.argv[3], { signal: controller.signal });
    console.info(`已有 SQLite 副本校验通过：${JSON.stringify(result)}（原文件只读访问，未初始化）`);
  } catch (error) {
    console.error(JSON.stringify({ code: error.code ?? 'SNAPSHOT_FAILED', detailCode: error.detailCode, message: error.message }));
    process.exitCode = receivedSignal === 'SIGINT' ? 130 : receivedSignal ? 143 : 1;
  } finally { process.off('SIGINT', onInt); process.off('SIGTERM', onTerm); }
}
