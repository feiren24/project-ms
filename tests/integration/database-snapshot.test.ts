import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, copyFileSync, readdirSync, readFileSync, chmodSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { checkExistingDatabase } from '../../server/src/db/existing.js';

const helperUrl = new URL('../../scripts/check-database-snapshot.mjs', import.meta.url).href;
const dirs: string[] = [];
let base: string;
beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), 'gw-snapshot-base-'));
  const app = buildApp({ dbPath: join(base, 'db.sqlite'), jobIntervalMs: 0 });
  try { await app.ready(); } finally { await app.close(); }
});
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) { chmodSync(join(dir, 'source'), 0o755); rmSync(dir, { recursive: true, force: true }); } });
afterAll(() => { rmSync(base, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'gw-snapshot-test-')); dirs.push(root);
  const source = join(root, 'source'), staging = join(root, 'staging'); mkdirSync(source); mkdirSync(staging);
  const path = join(source, 'db.sqlite'); copyFileSync(join(base, 'db.sqlite'), path);
  return { source, staging, path };
}
function fingerprint(dir: string) {
  return Object.fromEntries(readdirSync(dir).sort().map(name => [name, createHash('sha256').update(readFileSync(join(dir, name))).digest('hex')]));
}
async function run(path: string, staging: string, options?: { signal: AbortSignal }) {
  const { checkDatabaseSnapshot } = await import(helperUrl);
  return checkDatabaseSnapshot(path, staging, options);
}

describe('stopped database snapshot validation with real SQLite', () => {
  it('runs the production CLI with the selected Node driver and leaves source unchanged', () => {
    const f = fixture(); const before = fingerprint(f.source);
    chmodSync(f.path, 0o444); chmodSync(f.source, 0o555);
    const cli = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/check-database-snapshot.mjs'), f.path, f.staging], { encoding: 'utf8', timeout: 30_000 });
    expect(cli.status, cli.stderr).toBe(0); expect(cli.stdout).toContain('副本校验通过');
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });
  it('validates a cleanly closed WAL database in a readonly source directory without touching it', async () => {
    const f = fixture(); expect(readdirSync(f.source)).toEqual(['db.sqlite']);
    const before = fingerprint(f.source); chmodSync(f.path, 0o444); chmodSync(f.source, 0o555);
    // Non-root POSIX reproduction of the Docker readonly-mount bug.
    if (process.getuid?.() !== 0) expect(() => checkExistingDatabase(f.path)).toThrow(/readonly|open database/);
    await expect(run(f.path, f.staging)).resolves.toMatchObject({ sourceUnchanged: true, schemaCheck: 'passed' });
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
    expect((await fs.stat(f.path)).mode & 0o777).toBe(0o444);
  });

  it.each([false, true])('reads committed WAL data and rebuilds SHM (source SHM absent: %s)', async absent => {
    const f = fixture();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from ${JSON.stringify(new URL('../node_modules/better-sqlite3/lib/index.js', helperUrl).href)};
      const db = new Database(process.argv[1]); db.pragma('wal_autocheckpoint=0');
      db.exec("DELETE FROM notification_state WHERE key='initial_events_seen'");
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.exec("INSERT INTO notification_state VALUES('initial_events_seen','1')");
      process.exit(0);
    `, f.path], { encoding: 'utf8', cwd: resolve('.') });
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(f.path + '-wal')).toBe(true);
    // Demonstrate that copying only the main file loses a required committed marker.
    const incomplete = join(f.staging, 'incomplete.sqlite'); copyFileSync(f.path, incomplete);
    expect(() => checkExistingDatabase(incomplete)).toThrow(/notification_state/);
    for (const name of readdirSync(f.staging)) rmSync(join(f.staging, name));
    if (absent) rmSync(f.path + '-shm');
    const before = fingerprint(f.source);
    await expect(run(f.path, f.staging)).resolves.toMatchObject({ sourceUnchanged: true, schemaCheck: 'passed' });
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });

  it.each(['missing', 'empty', 'corrupt', 'schema', 'marker'])('rejects %s databases without repairing source', async kind => {
    const f = fixture();
    if (kind === 'missing') rmSync(f.path);
    if (kind === 'empty') writeFileSync(f.path, '');
    if (kind === 'corrupt') writeFileSync(f.path, 'not sqlite');
    if (kind === 'schema' || kind === 'marker') {
      const db = new Database(f.path); db.exec(kind === 'schema' ? 'DROP TABLE system_settings_receipts' : "DELETE FROM notification_state WHERE key='initial_events_seen'"); db.close();
    }
    const before = fingerprint(f.source);
    await expect(run(f.path, f.staging)).rejects.toThrow();
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });

  it('recovers a hot rollback journal only in the disposable copy', async () => {
    const f = fixture();
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import Database from ${JSON.stringify(new URL('../node_modules/better-sqlite3/lib/index.js', helperUrl).href)};
      const db=new Database(process.argv[1]); db.pragma('journal_mode=DELETE'); db.pragma('cache_size=1');
      db.exec("BEGIN IMMEDIATE; DELETE FROM notification_state; UPDATE homepage_tasks SET title=printf('%010000d',42)");
      process.exit(0);
    `, f.path], { encoding: 'utf8' });
    expect(child.status, child.stderr).toBe(0);
    expect(existsSync(f.path + '-journal')).toBe(true);
    const journal = readFileSync(f.path + '-journal');
    expect(journal.subarray(0, 8).toString('hex')).toBe('d9d505f920a163d7');
    const before = fingerprint(f.source);
    await expect(run(f.path, f.staging)).resolves.toMatchObject({ sourceUnchanged: true, schemaCheck: 'passed' });
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });

  it.each(['', '-wal', '-journal', '-shm'])('refuses a symlink at database suffix %s', async suffix => {
    const f = fixture(); const target = join(f.staging, 'external'); writeFileSync(target, 'do not touch');
    if (!suffix) rmSync(f.path); symlinkSync(target, f.path + suffix);
    await expect(run(f.path, f.staging)).rejects.toThrow(/符号链接/);
    expect(readFileSync(target, 'utf8')).toBe('do not touch'); expect(readdirSync(f.staging)).toEqual(['external']);
  });

  it('rejects insufficient space before copying and leaves unrelated staging files alone', async () => {
    const f = fixture(); writeFileSync(join(f.staging, 'unrelated'), 'keep');
    const stat = await fs.statfs(f.staging, { bigint: true });
    vi.spyOn(fs, 'statfs').mockResolvedValue({ ...stat, bavail: 0n } as never);
    const copy = vi.spyOn(fs, 'copyFile');
    await expect(run(f.path, f.staging)).rejects.toThrow(/空间不足/);
    expect(copy).not.toHaveBeenCalled(); expect(readdirSync(f.staging)).toEqual(['unrelated']);
  });

  it.each(['main', 'new-wal'])('detects a concurrent source change (%s) and removes its copy', async change => {
    const f = fixture(); const copy = fs.copyFile.bind(fs); let changed = false;
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      await copy(...args);
      if (!changed) { changed = true; writeFileSync(change === 'main' ? f.path : f.path + '-wal', 'concurrent writer'); }
    });
    await expect(run(f.path, f.staging)).rejects.toThrow(/变化/);
    expect(readdirSync(f.staging)).toEqual([]);
  });

  it('cleans a partial copy after an I/O failure without changing source', async () => {
    const f = fixture(); const before = fingerprint(f.source);
    vi.spyOn(fs, 'copyFile').mockRejectedValue(Object.assign(new Error('fixture disk failure'), { code: 'ENOSPC' }));
    await expect(run(f.path, f.staging)).rejects.toThrow(/复制/);
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });

  it('cleans staged data when interrupted during copying', async () => {
    const f = fixture(); const before = fingerprint(f.source), controller = new AbortController();
    const copy = fs.copyFile.bind(fs);
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => { await copy(...args); controller.abort(); });
    await expect(run(f.path, f.staging, { signal: controller.signal })).rejects.toThrow(/中断/);
    expect(fingerprint(f.source)).toEqual(before); expect(readdirSync(f.staging)).toEqual([]);
  });
});
