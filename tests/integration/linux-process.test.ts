import { it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, symlinkSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { buildApp } from '../../server/src/app.js';

it('documents safe defaults and refuses execution on unsupported operating systems',()=>{
  const script=resolve('scripts/linux.sh');
  expect(execFileSync('bash',[script,'help'],{encoding:'utf8'})).toContain('data/homepage-demo.sqlite');
  execFileSync('bash',['-n',script]);
  if(process.platform!=='linux')expect(()=>execFileSync('bash',[script,'start'],{stdio:'pipe'})).toThrow();
});

// Exercise the actual script's read-only OS gate on macOS as well as Linux.
// Only OS probes are fixtures; no installation, downloads or services run.
it.each([
  ['7','2.17','3.10.0','CentOS 7'],
  ['8','2.28','4.18.0','未运行'],
  ['9','2.34','5.14.0','未运行'],
  ['9','2.17','5.14.0','glibc 2.17 低于 2.28'],
  ['9','2.34','3.10.0','Linux 内核需要至少 4.18'],
  ['','2.34','5.14.0','无法识别 CentOS 版本'],
])('checks CentOS %s / glibc %s / kernel %s before touching data', (version,glibc,kernel,message)=>{
  const root=mkdtempSync(join(tmpdir(),'goodwork-centos-gate-'));
  try {
    mkdirSync(join(root,'scripts'));mkdirSync(join(root,'data'));
    cpSync(resolve('scripts/linux.sh'),join(root,'scripts/linux.sh'));cpSync(resolve('.node-version'),join(root,'.node-version'));
    const data=join(root,'data/homepage-demo.sqlite');writeFileSync(data,'original database marker');
    const probes=join(root,'probes.sh');writeFileSync(probes,`
uname() { case "$1" in -s) printf 'Linux\n';; -m) printf 'x86_64\n';; -r) printf '%s\n' "$TEST_KERNEL";; *) command uname "$@";; esac; }
getconf() { printf 'glibc %s\n' "$TEST_GLIBC"; }
awk() {
  case "$*" in
    *'/etc/os-release') case "$*" in *'key=VERSION_ID'*) printf '%s\n' "$TEST_VERSION";; *'key=ID'*) printf 'centos\n';; esac;;
    *) command awk "$@";;
  esac
}
`);
    const result=spawnSync('bash',[join(root,'scripts/linux.sh'),'status'],{encoding:'utf8',env:{...process.env,LC_ALL:'C',BASH_ENV:probes,TEST_VERSION:version,TEST_GLIBC:glibc,TEST_KERNEL:kernel}});
    expect(result.stdout+result.stderr).toContain(message);expect(result.status).toBe(1);
    expect(readFileSync(data,'utf8')).toBe('original database marker');expect(existsSync(join(root,'.runtime'))).toBe(false);
  } finally {rmSync(root,{recursive:true,force:true});}
});

// Run on a supported Linux host after npm ci && npm run build. No apt/dnf,
// downloads, original database or other project's processes are touched.
it.skipIf(process.platform!=='linux')('controls only its own detached process and preserves an existing database through restart',async()=>{
  const root=mkdtempSync(join(tmpdir(),'goodwork-linux-process-'));
  const server=createServer();await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const port=(server.address() as {port:number}).port;await new Promise<void>(done=>server.close(()=>done()));
  const script=join(root,'scripts/linux.sh');
  const run=(action:string)=>execFileSync('bash',[script,action],{encoding:'utf8',timeout:45000});
  try {
    for(const path of ['server','shared','scripts','client/dist'])cpSync(resolve(path),join(root,path),{recursive:true});
    for(const path of ['.node-version','package.json'])cpSync(resolve(path),join(root,path));
    symlinkSync(resolve('node_modules'),join(root,'node_modules'),'dir');mkdirSync(join(root,'data'));
    const dbPath=join(root,'data/homepage-demo.sqlite');
    const seed=buildApp({dbPath,jobIntervalMs:0});await seed.ready();await seed.close();
    writeFileSync(join(root,'.env.linux'),`PORT=${port}\nPUBLIC_BASE_URL=http://127.0.0.1:${port}\nDATABASE_PATH="${dbPath}"\nDATABASE_MODE=existing-only\nSERVE_WEB=true\nNODE_ENV=production\n`);
    expect(run('start')).toContain('启动成功');expect(run('status')).toContain('运行中');
    const first=readFileSync(join(root,'.runtime/goodwork.pid'),'utf8');
    expect(run('start')).toContain('已运行');expect(readFileSync(join(root,'.runtime/goodwork.pid'),'utf8')).toBe(first);
    expect((await fetch(`http://127.0.0.1:${port}/login`)).status).toBe(200);
    expect(run('restart')).toContain('启动成功');expect(readFileSync(join(root,'.runtime/goodwork.pid'),'utf8')).not.toBe(first);
    expect(run('stop')).toContain('服务已停止');expect(existsSync(dbPath)).toBe(true);
    // A forged PID record must never terminate another process.
    const unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);
    try {writeFileSync(join(root,'.runtime/goodwork.pid'),`${unrelated.pid} 0\n`);expect(run('stop')).toContain('未向其他进程发送信号');expect(unrelated.exitCode).toBe(null);}
    finally {unrelated.kill();}
  } finally {try{run('stop');}catch{}rmSync(root,{recursive:true,force:true});}
},120000);
