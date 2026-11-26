import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, readFileSync, readdirSync, writeFileSync, rmSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Explicit opt-in: uses a real local Linux daemon, temporary data only, and
// rebuilds the application once in the lifecycle test (may need network/cache).
const enabled = process.env.RUN_DOCKER_SNAPSHOT_TESTS === '1' && process.platform === 'linux';
const exec = promisify(execFile);
const roots: string[] = [];
let image: string;
const run = (command: string, args: string[], timeout = 120_000) => exec(command, args, { cwd: resolve('.'), timeout, maxBuffer: 8 * 1024 * 1024 });
const docker = (args: string[]) => run('docker', args);
const hashFiles = (dir: string) => Object.fromEntries(readdirSync(dir).filter(n => n.startsWith('fixture.sqlite')).sort().map(n => [n, createHash('sha256').update(readFileSync(join(dir, n))).digest('hex')]));

describe.skipIf(!enabled)('real Linux Docker stopped-WAL deployment (opt-in)', () => {
  beforeAll(async () => {
    if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) throw new Error('Real snapshot tests require a local Unix-socket Docker daemon');
    if (process.env.DOCKER_CONTEXT && process.env.DOCKER_CONTEXT !== 'default') throw new Error('Real snapshot tests require the default local Docker context');
    const context = (await docker(['context', 'show'])).stdout.trim();
    if (context && context !== 'default') throw new Error('Real snapshot tests require the default local Docker context');
    expect((await docker(['info', '--format', '{{.OSType}}'])).stdout.trim()).toBe('linux');
    image = process.env.GOODWORK_DOCKER_TEST_IMAGE || readFileSync(resolve('.runtime/docker-image.id'), 'utf8').trim();
    if (!image || image.startsWith('-') || /\s/.test(image)) throw new Error('Provide GOODWORK_DOCKER_TEST_IMAGE or an installed image ID');
    await docker(['image', 'inspect', image]);
  });
  afterEach(async () => {
    for (const root of roots.splice(0)) {
      const owned = (await docker(['ps', '-aq', '--filter', `label=goodwork.project=${root}`])).stdout.trim().split(/\s+/).filter(Boolean);
      if (owned.length) await docker(['rm', '-f', ...owned]);
      rmSync(root, { recursive: true, force: true });
    }
  });
  async function fixture() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'gw-real-snapshot-'))); roots.push(root);
    const source = join(root, 'data'), stage = join(root, 'stage'); mkdirSync(source); mkdirSync(stage, { mode: 0o700 });
    await docker(['run', '--rm', '--label', `goodwork.project=${root}`, '--network', 'none', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--mount', `type=bind,src=${source},dst=/app/data`, image,
      'node', '--import', 'tsx', '--input-type=module', '-e',
      "import {buildApp} from './server/src/app.ts'; const app=buildApp({dbPath:'/app/data/fixture.sqlite',jobIntervalMs:0}); await app.ready(); await app.close();"]);
    expect(readdirSync(source).filter(n => n.startsWith('fixture.sqlite'))).toEqual(['fixture.sqlite']);
    return { root, source, stage };
  }
  it('reproduces the original readonly mount failure and validates unchanged source using the mounted helper', async () => {
    const f = await fixture(); const before = hashFiles(f.source);
    const common = ['run', '--rm', '--label', `goodwork.project=${f.root}`, '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', `${process.getuid!()}:${process.getgid!()}`,
      '--mount', `type=bind,src=${f.source},dst=/source,readonly`];
    await expect(docker([...common, image, 'node', '--import', 'tsx', 'server/src/scripts/check-database.ts', '/source/fixture.sqlite'])).rejects.toThrow();
    const checked = await docker([...common,
      '--mount', `type=bind,src=${f.stage},dst=/check`,
      '--mount', `type=bind,src=${resolve('scripts/check-database-snapshot.mjs')},dst=/app/scripts/check-database-snapshot.mjs,readonly`,
      image, 'node', '--import', 'tsx', '/app/scripts/check-database-snapshot.mjs', '/source/fixture.sqlite', '/check']);
    expect(checked.stdout).toContain('副本校验通过'); expect(hashFiles(f.source)).toEqual(before); expect(readdirSync(f.stage)).toEqual([]);
  }, 120_000);

  it('runs real start → stop → install → start → restart against isolated existing data', async () => {
    const f = await fixture();
    for (const dir of ['scripts', '.runtime']) mkdirSync(join(f.root, dir));
    for (const file of ['centos7-docker.sh', 'check-database-snapshot.mjs']) copyFileSync(resolve('scripts', file), join(f.root, 'scripts', file));
    for (const file of ['.node-version', 'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json', 'tsconfig.base.json', 'tsconfig.server.json']) copyFileSync(resolve(file), join(f.root, file));
    for (const dir of ['client', 'server', 'shared']) cpSync(resolve(dir), join(f.root, dir), { recursive: true, filter: p => !p.split('/').some(part => ['node_modules', 'dist', 'data', 'system-secrets'].includes(part)) });
    const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot reserve test port');
    const port = address.port; await new Promise<void>(done => server.close(() => done()));
    writeFileSync(join(f.root, '.runtime/docker-settings'), `https://snapshot-${randomUUID()}.invalid\n${port}\n${join(f.source, 'fixture.sqlite')}\ndefault\n`, { mode: 0o600 });
    const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', image])).stdout.trim();
    writeFileSync(join(f.root, '.runtime/docker-image.id'), imageId); writeFileSync(join(f.root, '.env.docker'), '', { mode: 0o600 });
    const control = (...args: string[]) => run('bash', [join(f.root, 'scripts/centos7-docker.sh'), ...args], 2_400_000);
    await control('start');
    await control('stop');
    expect(existsSync(join(f.source, 'fixture.sqlite-wal'))).toBe(false);
    const before = hashFiles(f.source);
    await control('install', '--public-url', 'https://pm.example.com');
    expect(hashFiles(f.source)).toEqual(before);
    await control('start'); await control('restart');
    expect((await control('status')).stdout).toContain('running');
    const ids = (await docker(['ps', '-q', '--filter', `label=goodwork.project=${f.root}`])).stdout.trim().split(/\s+/).filter(Boolean);
    expect(ids).toHaveLength(1);
    const details = JSON.parse((await docker(['inspect', ids[0]!])).stdout)[0];
    expect(details.Config.Env).toContain('PUBLIC_BASE_URL=https://pm.example.com');
    expect(details.HostConfig.PortBindings['3100/tcp'][0].HostIp).toBe('127.0.0.1');
    expect(details.Mounts.some((m: { Source: string; RW: boolean }) => m.Source === f.source && m.RW)).toBe(true);
    await control('stop');
    expect(readdirSync(join(f.root, '.runtime')).filter(n => n.startsWith('db-check-'))).toEqual([]);
  }, 2_700_000);
});
