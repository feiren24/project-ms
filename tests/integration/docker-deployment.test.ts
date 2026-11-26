import { it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, realpathSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

vi.setConfig({ testTimeout: 30000 });
const dirs:string[]=[];
// Synchronous shell fixtures must yield between cases so Vitest can flush worker RPC updates.
afterEach(async()=>{
  for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});
  await new Promise<void>(resolve=>setImmediate(resolve));
});
function fixture() {
  const root=realpathSync(mkdtempSync(join(tmpdir(),'goodwork-docker-test-')));dirs.push(root);
  for(const dir of ['scripts','bin','data'])mkdirSync(join(root,dir));
  copyFileSync(resolve('scripts/centos7-docker.sh'),join(root,'scripts/centos7-docker.sh'));
  writeFileSync(join(root,'scripts/check-database-snapshot.mjs'),'// snapshot helper fixture\n');
  copyFileSync(resolve('.node-version'),join(root,'.node-version'));
  for(const file of ['Dockerfile','.dockerignore'])copyFileSync(resolve(file),join(root,file));
  writeFileSync(join(root,'data/homepage-demo.sqlite'),'original database marker');
  writeFileSync(join(root,'data/homepage-demo.sqlite-wal'),'original wal marker');
  writeFileSync(join(root,'data/homepage-demo.sqlite-shm'),'original shm marker');
  writeFileSync(join(root,'data/homepage-demo.sqlite-journal'),'original journal marker');
  mkdirSync(join(root,'data/system-secrets'));writeFileSync(join(root,'data/system-secrets/feishu-master-key.json'),'original secret marker');
  writeFileSync(join(root,'probes.sh'),`uname() { printf 'Linux\\n'; }\nflock() { return 0; }\ncurl() { printf '<div id="app"></div>\\n'; }\n`);
  writeFileSync(join(root,'bin/docker'),`#!/usr/bin/env python3
import sys,os,json
from pathlib import Path
args=sys.argv[1:];root=Path(os.environ['TEST_ROOT']);state=root/'state.json';image='sha256:'+'a'*64
with (root/'calls.jsonl').open('a') as f: f.write(json.dumps(args)+'\\n')
def read(): return json.loads(state.read_text()) if state.exists() else None
def save(value): state.write_text(json.dumps(value))
def at(flag): return args[args.index(flag)+1]
if args[0]=='context': sys.exit(1)
if args[0]=='info':
 print('linux' if at('--format')=='{{.OSType}}' else 'Docker service fixture');sys.exit(0)
if args[0]=='image': sys.exit(0)
if args[0]=='build': Path(at('--iidfile')).write_text(image);(root/'progress').write_text(os.environ.get('BUILDKIT_PROGRESS',''));sys.exit(0)
if args[0]=='ps':
 if '--filter' in args and os.environ.get('TEST_CLEANUP_UNCERTAIN')=='1': sys.exit(1)
 print('other' if os.environ.get('TEST_OTHER_MOUNT') else '');sys.exit(0)
if args[0]=='container':
 if args[-1]=='other':
  source=os.environ['TEST_OTHER_MOUNT'];print(str(len(source.encode()))+':'+source);sys.exit(0)
 if '-check-' in args[-1]:
  if os.environ.get('TEST_CLEANUP_UNCERTAIN')=='1': sys.exit(1)
  v=root/'validation.json'
  if not v.exists(): sys.exit(1)
  print(json.loads(v.read_text())['token']);sys.exit(0)
 s=read()
 if not s: sys.exit(1)
 if '--format' in args:
  f=at('--format')
  print(s['owner'] if 'goodwork.project' in f else str(s['running']).lower() if '.State.Running' in f else 'healthy' if '.State.Health.Status' in f else 'running' if s['running'] else 'exited')
 sys.exit(0)
if args[0]=='run':
 if '/app/scripts/check-database-snapshot.mjs' in args:
  token=[args[i+1].split('=',1)[1] for i,x in enumerate(args) if x=='--label' and args[i+1].startswith('goodwork.validation=')][0]
  (root/'validation.json').write_text(json.dumps({'token':token}))
  mount=[a for a in args if 'dst=/check' in a][0]
  stage=Path(mount.split('src=',1)[1].split(',dst=',1)[0])
  (root/'stage-mode').write_text(oct(stage.stat().st_mode & 0o777))
  (stage/'snapshot.sqlite').write_text('temporary snapshot')
  if os.environ.get('TEST_CHECK_SIGNAL'):
   import signal,time
   os.kill(os.getppid(),getattr(signal,'SIG'+os.environ['TEST_CHECK_SIGNAL']))
   time.sleep(60)
  if os.environ.get('TEST_BAD_DB')=='1': print('incompatible database',file=sys.stderr);sys.exit(1)
  print('read-only database check')
 elif '-d' in args:
  save({'owner':at('--label')[len('goodwork.project='):],'running':True});print('fixture-container-id')
 elif os.environ.get('TEST_BAD_NODE')=='1': print('Node cannot run on kernel',file=sys.stderr);sys.exit(1)
 sys.exit(0)
if args[0]=='stop':
 s=read();s['running']=False;save(s);sys.exit(0)
if args[0]=='rm':
 if '-check-' in args[-1]:
  (root/'validation.json').unlink(missing_ok=True)
 else: state.unlink()
 sys.exit(0)
if args[0]=='logs': sys.exit(0)
print('Unexpected docker command '+repr(args),file=sys.stderr);sys.exit(2)
`,{mode:0o755});
  const env={...process.env,PATH:join(root,'bin')+':'+process.env.PATH,LC_ALL:'C',BASH_ENV:join(root,'probes.sh'),TEST_ROOT:root,DOCKER_HOST:'',DOCKER_CONTEXT:'',BUILDKIT_PROGRESS:''};
  return {root,
    run:(args:string[],extra:Record<string,string>={})=>spawnSync('bash',[join(root,'scripts/centos7-docker.sh'),...args],{encoding:'utf8',timeout:30000,env:{...env,...extra}}),
    calls:()=>existsSync(join(root,'calls.jsonl'))?readFileSync(join(root,'calls.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line) as string[]):[],
  };
}
function success(result:ReturnType<ReturnType<typeof fixture>['run']>) {expect(result.status,result.stdout+result.stderr).toBe(0);}
const publishedPort=(args:string[])=>args[args.indexOf('-p')+1];
it('keeps existing data outside the image and uses read-only validation before writable runtime mounts',()=>{
  const f=fixture();writeFileSync(join(f.root,'.env.linux'),'FEISHU_MASTER_KEY=test-placeholder\nDATABASE_PATH=/old/path\n');
  success(f.run(['install','--public-ip','203.0.113.10']));
  expect(f.calls().some(args=>args.includes('-d'))).toBe(false);
  expect(readFileSync(join(f.root,'progress'),'utf8')).toBe('plain');
  expect(f.calls().find(args=>args[0]==='build')).toContain('--progress=plain');
  expect(readFileSync(join(f.root,'.env.docker'),'utf8')).toContain('FEISHU_MASTER_KEY=test-placeholder');
  success(f.run(['start']));const runs=f.calls().filter(args=>args[0]==='run');
  const checks=runs.filter(args=>args.includes('/app/scripts/check-database-snapshot.mjs'));
  expect(checks).toHaveLength(2);
  for(const args of checks) {
    expect(args).toContain(`type=bind,src=${f.root}/data,dst=/source,readonly`);
    expect(args).toContain(`type=bind,src=${f.root}/scripts/check-database-snapshot.mjs,dst=/app/scripts/check-database-snapshot.mjs,readonly`);
    const stage=args.find(a=>a.includes('dst=/check'))!;
    expect(stage).toMatch(/\/\.runtime\/db-check-[^,]+,dst=\/check$/);
    expect(args.slice(-6)).toEqual(['node','--import','tsx','/app/scripts/check-database-snapshot.mjs','/source/homepage-demo.sqlite','/check']);
    for(const flag of ['--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--user','--name'])expect(args).toContain(flag);
    expect(existsSync(stage.split('src=')[1]!.split(',dst=')[0]!)).toBe(false);
  }
  expect(readFileSync(join(f.root,'stage-mode'),'utf8')).toBe('0o700');
  expect(existsSync(join(f.root,'validation.json'))).toBe(false);
  const start=runs.find(args=>args.includes('-d'))!;
  expect(start).toContain(`type=bind,src=${f.root}/data,dst=/app/data`);
  expect(start).toContain('DATABASE_MODE=existing-only');expect(start).toContain('DATABASE_PATH=/app/data/homepage-demo.sqlite');
  expect(start).toContain('PUBLIC_BASE_URL=http://203.0.113.10:3100');expect(start).toContain('--restart=no');
  expect(start).not.toContain('--privileged');expect(start).not.toContain('/var/run/docker.sock');
  success(f.run(['start']));expect(f.calls().filter(args=>args.includes('-d'))).toHaveLength(1);
  success(f.run(['restart']));expect(f.calls().filter(args=>args.includes('-d'))).toHaveLength(2);
  success(f.run(['stop']));
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-wal'),'utf8')).toBe('original wal marker');
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-shm'),'utf8')).toBe('original shm marker');
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-journal'),'utf8')).toBe('original journal marker');
  expect(readFileSync(join(f.root,'data/system-secrets/feishu-master-key.json'),'utf8')).toBe('original secret marker');
});
it('refuses missing data, remote daemons, failed Node probes and incompatible schemas without starting an app',()=>{
  for(const kind of ['missing','remote','node','schema']) {
    const f=fixture();if(kind==='missing')rmSync(join(f.root,'data/homepage-demo.sqlite'));
    const extra:Record<string,string>=kind==='remote'?{DOCKER_HOST:'tcp://remote.example:2376'}:kind==='node'?{TEST_BAD_NODE:'1'}:kind==='schema'?{TEST_BAD_DB:'1'}:{};
    const res=f.run(['install','--public-ip','203.0.113.10'],extra);expect(res.status,res.stdout+res.stderr).toBe(1);
    expect(f.calls().some(args=>args.includes('-d'))).toBe(false);expect(existsSync(join(f.root,'.env.docker'))).toBe(false);
    expect(existsSync(join(f.root,'.runtime/docker-image.id'))).toBe(false);
    if(kind==='missing')expect(existsSync(join(f.root,'data/homepage-demo.sqlite'))).toBe(false);
    if(kind==='node')expect(f.calls().some(args=>args.includes('--mount'))).toBe(false);
    if(kind==='remote')expect(f.calls()).toEqual([]);
  }
});
it('does not stop or remove another checkout container and allows stopping when data is missing',()=>{
  const f=fixture();writeFileSync(join(f.root,'state.json'),JSON.stringify({owner:'/another/project',running:true}));
  expect(f.run(['stop']).status).toBe(1);expect(f.calls().some(args=>['stop','rm'].includes(args[0]!))).toBe(false);
  writeFileSync(join(f.root,'state.json'),JSON.stringify({owner:f.root,running:true}));rmSync(join(f.root,'data/homepage-demo.sqlite'));
  success(f.run(['stop']));
});
it('supports explicit existing paths and preserves configuration during subsequent installations',()=>{
  const f=fixture(),path=join(f.root,'data/old database.sqlite');writeFileSync(path,'existing');
  success(f.run(['install','--public-ip','203.0.113.11','--port','3111','--db',path]));
  writeFileSync(join(f.root,'.env.docker'),'FEISHU_MASTER_KEY=keep-this\n');
  success(f.run(['install']));success(f.run(['start']));
  const start=f.calls().find(args=>args.includes('-d'))!;expect(publishedPort(start)).toBe('3111:3100');expect(start).toContain('DATABASE_PATH=/app/data/old database.sqlite');
  expect(readFileSync(join(f.root,'.env.docker'),'utf8')).toBe('FEISHU_MASTER_KEY=keep-this\n');
});
it('keeps data, secrets and local dependencies excluded from the Docker build inputs',()=>{
  const ignore=readFileSync(resolve('.dockerignore'),'utf8');expect(ignore.split('\n')).toContain('**');
  expect(ignore).not.toContain('!data');expect(ignore).not.toContain('!.env');
  for(const pattern of ['**/.env*','**/*.sqlite*','**/node_modules','**/system-secrets','**/backups'])expect(ignore).toContain(pattern);
  const dockerfile=readFileSync(resolve('Dockerfile'),'utf8');expect(dockerfile).not.toMatch(/COPY\s+\.\s/);expect(dockerfile).toContain('DATABASE_MODE=existing-only');expect(dockerfile).not.toContain('auth:bootstrap');
  // Both frontend and server configs extend this root file; omitting either
  // the context allowlist entry or COPY breaks compilation inside the image.
  expect(ignore.split('\n')).toContain('!tsconfig.base.json');
  expect(dockerfile).toMatch(/^COPY .*\btsconfig\.base\.json\b.* \.\/$/m);
});

it.each(['Dockerfile','.dockerignore'])('rejects missing %s before building or mounting any database',file=>{
  const f=fixture();rmSync(join(f.root,file));
  const result=f.run(['install','--public-ip','203.0.113.10']);
  expect(result.status,result.stdout+result.stderr).toBe(1);expect(result.stderr).toContain(file);
  expect(f.calls().some(args=>args[0]==='build'||args.includes('--mount'))).toBe(false);
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
});

it('passes an explicit APT mirror to the build and retains it for later installs',()=>{
  const f=fixture();
  success(f.run(['install','--public-ip','203.0.113.10','--apt-mirror','ustc']));
  success(f.run(['install']));
  const builds=f.calls().filter(args=>args[0]==='build');expect(builds).toHaveLength(2);
  for(const build of builds)expect(build).toContain('APT_MIRROR=ustc');
  success(f.run(['install','--apt-mirror','default']));
  expect(f.calls().filter(args=>args[0]==='build').at(-1)).toContain('APT_MIRROR=default');
});
it('rejects unknown mirror choices without building or changing a database',()=>{
  const f=fixture();const result=f.run(['install','--public-ip','203.0.113.10','--apt-mirror','unknown']);
  expect(result.status).toBe(1);expect(result.stderr).toContain('default 或 ustc');
  expect(f.calls().some(args=>args[0]==='build')).toBe(false);
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
});

it('accepts a reverse-proxied domain origin, reuses it from settings and binds loopback only',()=>{
  const f=fixture();writeFileSync(join(f.root,'.env.linux'),'FEISHU_MASTER_KEY=test-placeholder\nPUBLIC_BASE_URL=http://203.0.113.10:3100\n');
  success(f.run(['install','--public-url','https://pm.example.com']));
  // 复制过来的 .env.docker 会被 -e 静默覆盖，必须明确告知，否则用户改那里会以为生效。
  expect(f.run(['start']).stdout).toContain('PUBLIC_BASE_URL 会被脚本参数覆盖');
  const start=f.calls().find(args=>args.includes('-d'))!;
  expect(start).toContain('PUBLIC_BASE_URL=https://pm.example.com');
  // HTTPS 由反代终止，容器不得再对公网发布明文端口。
  expect(publishedPort(start)).toBe('127.0.0.1:3100:3100');
});

it('treats --public-url and --public-ip as one origin and keeps direct HTTP publicly bound',()=>{
  const byUrl=fixture();success(byUrl.run(['install','--public-url','http://203.0.113.10:3100']));success(byUrl.run(['start']));
  const byIp=fixture();success(byIp.run(['install','--public-ip','203.0.113.10','--port','3100']));success(byIp.run(['start']));
  const urlStart=byUrl.calls().find(args=>args.includes('-d'))!,ipStart=byIp.calls().find(args=>args.includes('-d'))!;
  expect(urlStart).toContain('PUBLIC_BASE_URL=http://203.0.113.10:3100');
  expect(ipStart).toContain('PUBLIC_BASE_URL=http://203.0.113.10:3100');
  expect(publishedPort(urlStart)).toBe('3100:3100');
  expect(publishedPort(ipStart)).toBe('3100:3100');
});

it('rejects malformed or unsupported public origins before building or touching data',()=>{
  for(const origin of ['ftp://pm.example.com','https://pm.example.com/path','https://user:pw@pm.example.com','https://0.0.0.0','https://pm.example.com:99999']) {
    const f=fixture();const result=f.run(['install','--public-url',origin]);
    expect(result.status,origin+result.stdout+result.stderr).toBe(1);
    expect(result.stderr,origin).toContain('访问地址');
    expect(f.calls().some(args=>args[0]==='build'||args.includes('--mount')),origin).toBe(false);
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
  }
});

it('rejects a public origin combined with --public-ip or passed outside install',()=>{
  const both=fixture();
  expect(both.run(['install','--public-ip','203.0.113.10','--public-url','https://pm.example.com']).status).toBe(1);
  const late=fixture();success(late.run(['install','--public-ip','203.0.113.10']));
  expect(late.run(['start','--public-url','https://pm.example.com']).status).toBe(1);
});

it('reads a legacy bare-IPv4 settings file without reinstalling',()=>{
  const f=fixture();success(f.run(['install','--public-ip','203.0.113.11','--port','3111']));
  writeFileSync(join(f.root,'.runtime/docker-settings'),`203.0.113.11\n3111\n${join(f.root,'data/homepage-demo.sqlite')}\ndefault\n`);
  success(f.run(['start']));
  const start=f.calls().find(args=>args.includes('-d'))!;
  expect(start).toContain('PUBLIC_BASE_URL=http://203.0.113.11:3111');
  expect(publishedPort(start)).toBe('3111:3100');
});

it('runs check with no origin configuration on a fresh machine and after install',()=>{
  const fresh=fixture();success(fresh.run(['check']));
  const installed=fixture();success(installed.run(['install','--public-url','https://pm.example.com']));success(installed.run(['check']));
});

// 多字节 locale 下 bash 会把紧随 `$VAR` 的 UTF-8 首字节并入变量名：`$HOST_PORT；` 被解析成
// 未定义变量，脚本以 `unbound variable` 退出（在 LANG=zh_CN.UTF-8 的服务器上必然发生）。
// 上面夹具固定 LC_ALL=C，单字节 locale 不会复现该解析，所以这一整类问题从未被覆盖。
it('never lets a shell variable run into a multibyte character',()=>{
  // 必须先按字节扫描：这类问题只出现在容器真正启动成功后的输出行，动态用例也不保证每次都跑到。
  // linux.sh 有 9 处同类历史问题（宿主直装路径），本次范围外，另行处理。
  const pending=new Set(['linux.sh']),offenders:string[]=[];
  for(const name of readdirSync(resolve('scripts')).filter(file=>file.endsWith('.sh')&&!pending.has(file))){
    // latin1 让每个字节对应一个 charCode，可直接判断原始字节是否 ≥0x80。
    for(const [index,line] of readFileSync(resolve('scripts',name)).toString('latin1').split('\n').entries())
      for(const match of line.matchAll(/\$[A-Za-z_][A-Za-z0-9_]*/g))
        if(line.charCodeAt(match.index!+match[0].length)>=0x80)
          offenders.push(`${name}:${index+1} ${match[0]}${line.slice(match.index!+match[0].length,match.index!+match[0].length+1)}`);
  }
  expect(offenders).toEqual([]);
});

function multibyteLocale():string|null {
  // bash 只在多字节 locale 下走这段解析，而未生成的 locale 会静默退回单字节；必须实测而非假定名称。
  for(const locale of ['C.UTF-8','en_US.UTF-8','zh_CN.UTF-8']) {
    const probe=spawnSync('bash',['-c','V=3100; printf "%s\\n" "端口 $V。"'],{encoding:'utf8',env:{...process.env,LC_ALL:locale}});
    if(probe.stdout!=='端口 3100。\n') return locale;
  }
  return null;
}
it('keeps operator messages intact under a multibyte locale',ctx=>{
  const locale=multibyteLocale();
  if(!locale) ctx.skip();
  const f=fixture();
  const install=f.run(['install','--public-url','https://pm.example.com','--port','3111'],{LC_ALL:locale!});
  success(install);
  const start=f.run(['start'],{LC_ALL:locale!});success(start);
  expect(start.stdout).toContain('启动成功：https://pm.example.com/login；数据库仍为 ');
  expect(start.stdout).toContain(`${join(f.root,'data/homepage-demo.sqlite')}。请使用原账号。`);
  expect(start.stdout).toContain('容器端口仅绑定 127.0.0.1:3111，无需对公网放行；请由反向代理访问。');
  expect(install.stdout).toContain('容器端口仅绑定 127.0.0.1:3111；反向代理请指向该地址，无需对公网放行。');
  expect(readFileSync(join(f.root,'.runtime/docker-settings'),'utf8').split('\n')[1]).toBe('3111');
});

it('requires check and install to use a stopped app while repeated start remains idempotent',()=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));success(f.run(['start']));
  const before=f.calls().filter(a=>a.includes('/app/scripts/check-database-snapshot.mjs')).length;
  for(const action of ['check','install']) {
    const result=f.run([action]);expect(result.status).toBe(1);expect(result.stderr).toContain('stop');
  }
  success(f.run(['start']));
  expect(f.calls().filter(a=>a.includes('/app/scripts/check-database-snapshot.mjs'))).toHaveLength(before);
});
it('refuses other running containers mounting the database or its parent without stopping them',()=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));
  symlinkSync(join(f.root,'data'),join(f.root,'data-alias'));
  for(const mount of [f.root,join(f.root,'data'),join(f.root,'data-alias'),join(f.root,'data/homepage-demo.sqlite'),join(f.root,'data/homepage-demo.sqlite-wal')]) {
    const before=f.calls().length;
    const result=f.run(['start'],{TEST_OTHER_MOUNT:mount});expect(result.status,result.stdout+result.stderr).toBe(1);
    expect(result.stderr).toContain('other');expect(f.calls().slice(before).some(a=>['stop','rm','run'].includes(a[0]!))).toBe(false);
  }
  success(f.run(['start'],{TEST_OTHER_MOUNT:join(f.root,'scripts')}));
});
it('cleans only its own snapshot and preserves stopped app, settings, image and originals on validation failure',()=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));success(f.run(['start']));success(f.run(['stop']));
  const settings=readFileSync(join(f.root,'.runtime/docker-settings'),'utf8'),image=readFileSync(join(f.root,'.runtime/docker-image.id'),'utf8');
  const unrelated=join(f.root,'.runtime/db-check-unrelated');mkdirSync(unrelated);writeFileSync(join(unrelated,'keep'),'preserve');
  for(const action of ['check','install','start','restart']) {
    const result=f.run([action],{TEST_BAD_DB:'1'});expect(result.status).toBe(1);
    expect(readFileSync(join(f.root,'.runtime/docker-settings'),'utf8')).toBe(settings);
    expect(readFileSync(join(f.root,'.runtime/docker-image.id'),'utf8')).toBe(image);
    expect(JSON.parse(readFileSync(join(f.root,'state.json'),'utf8')).running).toBe(false);
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-wal'),'utf8')).toBe('original wal marker');
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-shm'),'utf8')).toBe('original shm marker');
    expect(readFileSync(join(f.root,'data/homepage-demo.sqlite-journal'),'utf8')).toBe('original journal marker');
    expect(existsSync(join(f.root,'validation.json'))).toBe(false);
    expect(readdirSync(join(f.root,'.runtime')).filter(n=>n.startsWith('db-check-'))).toEqual(['db-check-unrelated']);
  }
});
it.each(['missing','empty','symlink'])('rejects a %s snapshot helper before any image build or database mount',kind=>{
  const f=fixture(),helper=join(f.root,'scripts/check-database-snapshot.mjs');
  if(kind==='missing')rmSync(helper);else if(kind==='symlink'){rmSync(helper);symlinkSync(join(f.root,'.node-version'),helper);}else writeFileSync(helper,'');
  const result=f.run(['install','--public-url','https://pm.example.com']);expect(result.status).toBe(1);
  expect(result.stderr).toContain('check-database-snapshot.mjs');
  expect(f.calls().some(a=>a[0]==='build'||a.includes('--mount'))).toBe(false);
});

it.each(['INT','TERM'])('cleans the owned validation container and stage on %s',signal=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));
  const result=f.run(['check'],{TEST_CHECK_SIGNAL:signal});
  expect(result.status,result.stdout+result.stderr).toBe(signal==='INT'?130:143);
  expect(existsSync(join(f.root,'validation.json'))).toBe(false);
  expect(readdirSync(join(f.root,'.runtime')).filter(n=>n.startsWith('db-check-'))).toEqual([]);
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
});

it('rejects ambiguous running-container mount paths conservatively',()=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));
  const result=f.run(['check'],{TEST_OTHER_MOUNT:join(f.root,'scripts')+'\n'+join(f.root,'bin')});
  expect(result.status).toBe(1);expect(result.stderr).toContain('无法安全解析');
});

it('preserves snapshot recovery information when Docker cleanup cannot confirm container absence',()=>{
  const f=fixture();success(f.run(['install','--public-url','https://pm.example.com']));
  const before=f.calls().length;
  const result=f.run(['check'],{TEST_CHECK_SIGNAL:'TERM',TEST_CLEANUP_UNCERTAIN:'1'});
  expect(result.status,result.stdout+result.stderr).toBe(143);
  const stageNames=readdirSync(join(f.root,'.runtime')).filter(n=>n.startsWith('db-check-'));
  expect(stageNames).toHaveLength(1);
  const stage=join(f.root,'.runtime',stageNames[0]!);
  const calls=f.calls().slice(before),run=calls.find(a=>a.includes('/app/scripts/check-database-snapshot.mjs'))!;
  const name=run[run.indexOf('--name')+1]!;
  expect(result.stderr).toContain('无法确认校验容器');
  expect(result.stderr).toContain(name);expect(result.stderr).toContain(stage);
  expect(result.stderr).toContain(`goodwork.validation=${stageNames[0]}`);
  expect(calls.some(a=>a[0]==='ps'&&a.includes(`name=^/${name}$`))).toBe(true);
  expect(calls.some(a=>a[0]==='rm')).toBe(false);
  expect(existsSync(join(stage,'snapshot.sqlite'))).toBe(true);
  expect(existsSync(join(f.root,'validation.json'))).toBe(true);
  expect(readFileSync(join(f.root,'data/homepage-demo.sqlite'),'utf8')).toBe('original database marker');
});
