import { test as base, expect, type Page, type Route } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../server/src/app.js';
import { createInitialAdmin } from '../../server/src/modules/auth/index.js';
import type { AuthSession } from '../../shared/src/auth.js';
import type { WorkstreamWorkspace } from '../../shared/src/workstreams.js';

// Real authentication and business handlers, exclusively in a disposable SQLite database.
const password = 'Workgroups-browser-admin-2026';
type Fixture = { app: FastifyInstance; db: Database.Database; cookie: string; session: AuthSession };
async function forward(route: Route, app: FastifyInstance) {
 const request = route.request(), url = new URL(request.url());
 const response = await app.inject({ method: request.method() as 'GET'|'POST'|'PATCH', url: url.pathname + url.search, headers: await request.allHeaders(), payload: request.postData() || undefined });
 const headers = Object.fromEntries(Object.entries(response.headers).filter(([name]) => !['content-length','transfer-encoding','connection'].includes(name)).map(([name,value]) => [name, Array.isArray(value) ? value.join('\n') : String(value)]));
 await route.fulfill({ status: response.statusCode, headers, body: response.body });
}
const test = base.extend<{ fixture: Fixture }>({
 fixture: async ({}, use) => {
  const directory = await mkdtemp(join(tmpdir(),'goodwork-workgroups-browser-')), dbPath = join(directory,'test.sqlite');
  const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath, clock: () => new Date('2026-09-07T08:00:00Z'), snapshotIntervalMs:0, riskIntervalMs:0, jobIntervalMs:0, secureCookies:false });
  const db = new Database(dbPath);
  try {
   await createInitialAdmin(db,{username:'admin',name:'分组验收管理员',password}); await app.ready();
   const response = await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'admin',password}});
   expect(response.statusCode).toBe(200);
   await use({app,db,cookie:String(response.headers['set-cookie']).split(';')[0]!,session:response.json().data});
  } finally { await app.close(); db.close(); await rm(directory,{recursive:true,force:true}); }
 },
 context: async ({context,fixture},use) => { await context.route('**/api/v1/**',route=>forward(route,fixture.app)); try { await use(context); } finally { await context.unrouteAll({behavior:'wait'}); } },
});
const headers = (f: Fixture) => ({cookie:f.cookie,'x-csrf-token':f.session.csrfToken,origin:'http://127.0.0.1:5174','idempotency-key':crypto.randomUUID()});
async function state(f: Fixture, projectId='phase-one'):Promise<WorkstreamWorkspace> { const r=await f.app.inject({url:`/api/v1/projects/${projectId}/workstreams`,headers:{cookie:f.cookie}});expect(r.statusCode,r.body).toBe(200);return r.json().data; }
async function apiGroup(f: Fixture,name:string) { const w=await state(f);const r=await f.app.inject({method:'POST',url:'/api/v1/projects/phase-one/workstreams',headers:headers(f),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'临时浏览器测试准备',workstream:{name,description:'原始说明',ownerId:'chen',color:'purple'}}});expect(r.statusCode,r.body).toBe(200);return (r.json().data as WorkstreamWorkspace).workstreams.find(g=>g.name===name)!; }
async function login(page: Page, username='admin', pass=password) {
 await page.goto('/projects/phase-one/workstreams');
 await page.getByLabel('登录账号',{exact:true}).fill(username); await page.getByLabel('密码',{exact:true}).fill(pass);await page.getByRole('button',{name:'登录',exact:true}).click();
 await expect(page.getByRole('heading',{name:'工作分组',exact:true})).toBeVisible();
}
async function module(page: Page, name:string) { await page.getByRole('button',{name,exact:true}).click();await expect(page.getByRole('heading',{name,exact:true}).first()).toBeVisible(); }
async function confirmGroup(page: Page,_reason='明确本次分组调整范围') { const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);if(await dialog.getByLabel('工作分组名称',{exact:true}).count()) await dialog.getByRole('button',{name:'核对变更',exact:true}).click();else await expect(dialog.getByRole('button',{name:'核对变更',exact:true})).toHaveCount(0);await dialog.getByRole('button',{name:'确认保存',exact:true}).click();await expect(dialog).toHaveCount(0); }
async function task(page:Page,title:string) { await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByRole('dialog').getByLabel(/任务名称/).fill(title);await page.getByRole('button',{name:'创建任务',exact:true}).click();await expect(page.getByRole('dialog').getByRole('heading',{name:title,exact:true})).toBeVisible();await page.getByRole('button',{name:'关闭任务详情',exact:true}).click(); }

test('creates a workgroup, shows its empty plan row, creates a task and synchronizes rename, color, ordering and audit',async({page,fixture})=>{
 await login(page);let prompts=0;page.on('dialog',async dialog=>{prompts++;await dialog.dismiss();});
 await page.getByRole('button',{name:'＋ 新增工作分组',exact:true}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('工作分组名称',{exact:true}).fill('质量保障');await dialog.getByLabel('分组说明',{exact:true}).fill('发布与独立质量检查');await dialog.getByRole('combobox',{name:'协调负责人',exact:true}).selectOption('chen');await dialog.getByRole('combobox',{name:'分组颜色',exact:true}).selectOption('purple');await confirmGroup(page);
 expect(prompts).toBe(0);await expect(page.getByTestId('workstream-row').filter({hasText:'质量保障'})).toContainText('0 项');
 await module(page,'完整计划');await expect(page.locator('.gantt-row').filter({hasText:'质量保障'})).toBeVisible();
 await module(page,'工作分组');await page.getByRole('button',{name:'查看质量保障任务',exact:true}).click();await task(page,'分组质量检查任务');
 await module(page,'工作分组');await expect(page.getByTestId('workstream-row').filter({hasText:'质量保障'})).toContainText('1 项未完成');
 await page.getByRole('button',{name:'编辑质量保障',exact:true}).click();await page.getByLabel('工作分组名称',{exact:true}).fill('质量与发布');await page.getByRole('combobox',{name:'分组颜色',exact:true}).selectOption('green');await confirmGroup(page);
 await page.getByRole('button',{name:'上移质量与发布',exact:true}).click();await page.getByRole('button',{name:'确认上移',exact:true}).click();await expect(dialog).toHaveCount(0);
 const w=await state(fixture);expect(w.workstreams.at(-2)?.name).toBe('质量与发布');
 await page.getByText('分组变更记录',{exact:false}).first().click();await expect(page.locator('.wg-history')).toContainText('新增分组');await expect(page.locator('.wg-history')).toContainText('编辑分组');await expect(page.locator('.wg-history')).toContainText('调整顺序');
 await module(page,'完整计划');await expect(page.locator('.gantt-row.is-group').nth(5)).toContainText('质量与发布');
 await module(page,'项目总览');await expect(page.locator('.stream-table-row').filter({hasText:'质量与发布'}).locator('.stream-icon')).toHaveClass(/green/);
 await module(page,'统计分析');await expect(page.locator('select option').filter({hasText:'质量与发布'})).toHaveCount(1);
});

test('moving groups only requires confirmation, supports cancellation and records each direction once',async({page,fixture})=>{
 await login(page);const before=await state(fixture), group=before.workstreams[1]!;
 let prompts=0, requests=0;page.on('dialog',async dialog=>{prompts++;await dialog.dismiss();});
 page.on('request',request=>{if(request.method()==='POST' && request.url().endsWith('/move')) requests++;});
 await expect(page.getByRole('button',{name:`上移${before.workstreams[0]!.name}`,exact:true})).toBeDisabled();
 await expect(page.getByRole('button',{name:`下移${before.workstreams.at(-1)!.name}`,exact:true})).toBeDisabled();
 await page.getByLabel('搜索工作分组',{exact:true}).fill(group.name);
 await expect(page.getByRole('button',{name:`上移${group.name}`,exact:true})).toBeDisabled();
 await page.getByLabel('搜索工作分组',{exact:true}).fill('');
 const dialog=page.getByRole('dialog');
 await page.getByRole('button',{name:`上移${group.name}`,exact:true}).click();
 await expect(dialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 await expect(dialog.getByRole('button',{name:'核对变更',exact:true})).toHaveCount(0);
 await expect(dialog).toContainText(group.name);
 await dialog.getByRole('button',{name:'取消',exact:true}).click();await expect(dialog).toHaveCount(0);
 expect(await state(fixture)).toEqual(before);expect(requests).toBe(0);expect(prompts).toBe(0);
 for(const direction of ['上移','下移']) {
  await page.getByRole('button',{name:`${direction}${group.name}`,exact:true}).click();
  await expect(dialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:`确认${direction}`,exact:true}).click();await expect(dialog).toHaveCount(0);
  const current=await state(fixture);
  expect(current.workstreams[direction==='上移'?0:1]?.id).toBe(group.id);
  expect(current.history[0]).toMatchObject({workstreamId:group.id,action:'workstream.move',reason:`${direction}工作分组`,actor:'分组验收管理员'});
 }
 const after=await state(fixture);expect(after.version).toBe(before.version+2);expect(after.history.length).toBe(before.history.length+2);expect(requests).toBe(2);expect(prompts).toBe(0);
});

test('moving after a version conflict refreshes the confirmation without asking for a reason',async({page,fixture})=>{
 const group=await apiGroup(fixture,'排序冲突分组');await login(page);
 await page.getByRole('button',{name:'上移排序冲突分组',exact:true}).click();
 const w=await state(fixture);const response=await fixture.app.inject({method:'PATCH',url:`/api/v1/projects/phase-one/workstreams/${group.id}`,headers:headers(fixture),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'另一个窗口更名',workstream:{name:'最新排序分组',description:group.description,ownerId:group.ownerId,color:group.color}}});expect(response.statusCode,response.body).toBe(200);
 const dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'确认上移',exact:true}).click();await expect(dialog.getByRole('alert')).toContainText('已更新');
 await expect(dialog.getByRole('button',{name:'确认上移',exact:true})).toBeDisabled();
 await dialog.getByRole('button',{name:'读取最新分组',exact:true}).click();await expect(dialog).toContainText('最新排序分组');
 await expect(dialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);await expect(dialog.getByRole('button',{name:'核对变更',exact:true})).toHaveCount(0);
 expect((await state(fixture)).version).toBe(w.version+1);
 await dialog.getByRole('button',{name:'确认上移',exact:true}).click();await expect(dialog).toHaveCount(0);
 const after=await state(fixture);expect(after.workstreams.at(-2)?.id).toBe(group.id);expect(after.history[0]?.reason).toBe('上移工作分组');
});

test('failed moves remain retryable and disable repeat submission while saving',async({page,fixture})=>{
 await login(page);const before=await state(fixture);let requests=0;
 let release!:()=>void;const pending=new Promise<void>(resolve=>{release=resolve;});
 await page.route('**/workstreams/*/move',async route=>{
  requests++;
  if(requests===1) { await pending;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEMPORARY_FAILURE',message:'暂时无法调整顺序，请重试。'}})}); }
  else await forward(route,fixture.app);
 });
 const dialog=page.getByRole('dialog');await page.getByRole('button',{name:'下移系统底座',exact:true}).click();
 try {
  await dialog.getByRole('button',{name:'确认下移',exact:true}).click();
  await expect(dialog.getByRole('button',{name:'正在保存…',exact:true})).toBeDisabled();
  await expect(dialog.getByRole('button',{name:'取消',exact:true})).toBeDisabled();
  await expect.poll(()=>requests).toBe(1);
 } finally { release(); }
 await expect(dialog.getByRole('alert')).toContainText('请重试');expect((await state(fixture)).version).toBe(before.version);
 await expect(dialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 await dialog.getByRole('button',{name:'确认下移',exact:true}).click();await expect(dialog).toHaveCount(0);
 const after=await state(fixture);expect(after.workstreams[1]?.name).toBe('系统底座');expect(after.version).toBe(before.version+1);expect(after.history.length).toBe(before.history.length+1);expect(requests).toBe(2);
});

test('disabled groups retain existing task execution, leave new task choices, and re-enable cleanly',async({page,fixture})=>{
 const group=await apiGroup(fixture,'可暂停分组');await login(page);await page.getByRole('button',{name:'查看可暂停分组任务',exact:true}).click();await task(page,'停用后继续交付');
 await module(page,'工作分组');await page.getByRole('button',{name:'停用可暂停分组',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('1 项未完成');await confirmGroup(page,'暂停接收新任务，完成已有交付');
 await page.getByRole('button',{name:'查看可暂停分组任务',exact:true}).click();await expect(page.getByLabel('任务工作分组筛选')).toHaveValue(group.id);
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await expect(page.getByRole('combobox',{name:'所属工作分组',exact:true})).toBeVisible();await expect(page.getByRole('combobox',{name:'所属工作分组',exact:true}).locator(`option[value="${group.id}"]`)).toHaveCount(0);await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'查看任务 停用后继续交付',exact:true}).click();await page.getByRole('button',{name:'开始任务',exact:true}).click();await expect(page.getByLabel('操作说明',{exact:false})).toHaveCount(0);await page.getByRole('button',{name:'确认开始',exact:true}).click();await expect(page.locator('.task-table tbody tr').filter({hasText:'停用后继续交付'})).toContainText('进行中');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();await page.getByRole('button',{name:'查看任务 停用后继续交付',exact:true}).click();
 await page.getByRole('button',{name:'标记完成',exact:true}).click();await expect(page.getByLabel('操作说明',{exact:false})).toHaveCount(0);await page.getByRole('button',{name:'确认完成',exact:true}).click();await expect(page.locator('.task-table tbody tr').filter({hasText:'停用后继续交付'})).toContainText('已完成');await page.getByRole('button',{name:'关闭任务详情',exact:true}).click();
 await module(page,'工作分组');await expect(page.getByTestId('workstream-row').filter({hasText:'可暂停分组'})).toContainText('0 项未完成');await page.getByRole('button',{name:'启用可暂停分组',exact:true}).click();await confirmGroup(page,'恢复新增任务');
 await page.getByRole('button',{name:'查看可暂停分组任务',exact:true}).click();await page.getByRole('button',{name:'新建任务',exact:true}).click();await expect(page.getByRole('combobox',{name:'所属工作分组',exact:true})).toHaveValue(group.id);
});

test('group drilldown replaces incompatible task filters and the quick management entry protects a draft',async({page})=>{
 await login(page);await module(page,'任务管理');await page.getByLabel('搜索任务',{exact:true}).fill('不存在的任务关键词');await page.getByRole('button',{name:/我的任务/}).click();await page.getByLabel('任务优先级筛选').selectOption('P0');await module(page,'工作分组');await page.getByRole('button',{name:'查看系统底座任务',exact:true}).click();
 await expect(page.getByLabel('搜索任务',{exact:true})).toHaveValue('');await expect(page.getByLabel('任务优先级筛选')).toHaveValue('');await expect(page.locator('.task-table tbody tr')).not.toHaveCount(0);
 await page.getByRole('button',{name:'新建任务',exact:true}).click();await page.getByLabel(/任务名称/).fill('离开前保留的草稿');await page.getByRole('button',{name:'管理工作分组',exact:true}).click();await expect(page.getByRole('heading',{name:'还有未保存的内容',exact:true})).toBeVisible();await page.getByRole('button',{name:'保留并继续编辑',exact:true}).click();await expect(page.getByLabel(/任务名称/)).toHaveValue('离开前保留的草稿');
});

test('duplicate and version conflict recovery preserve input and expose latest saved fields before retry',async({page,fixture})=>{
 const group=await apiGroup(fixture,'冲突核对分组');await login(page);await page.getByRole('button',{name:'编辑冲突核对分组',exact:true}).click();await page.getByLabel('工作分组名称',{exact:true}).fill('本地修改名称');await expect(page.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 const w=await state(fixture);const external=await fixture.app.inject({method:'PATCH',url:`/api/v1/projects/phase-one/workstreams/${group.id}`,headers:headers(fixture),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'另一窗口修改说明',workstream:{name:group.name,description:'其他编辑者最新保存的说明',ownerId:group.ownerId,color:group.color}}});expect(external.statusCode,external.body).toBe(200);
 await page.getByRole('button',{name:'核对变更',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('已更新');await page.getByRole('button',{name:'读取最新分组并保留填写',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('其他编辑者最新保存的说明');await expect(page.getByLabel('工作分组名称',{exact:true})).toHaveValue('本地修改名称');await expect(page.getByRole('button',{name:'核对变更',exact:true})).toBeDisabled();await page.getByLabel('我已逐项核对，确认按当前草稿保存',{exact:true}).check();await page.getByRole('button',{name:'核对变更',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'＋ 新增工作分组',exact:true}).click();await page.getByLabel('工作分组名称',{exact:true}).fill('系统底座');await expect(page.getByLabel('操作原因',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'核对变更',exact:true}).click();await page.getByRole('button',{name:'确认保存',exact:true}).click();await expect(page.getByRole('alert')).toContainText('同名');await page.getByRole('button',{name:'返回修改',exact:true}).click();await expect(page.getByLabel('工作分组名称',{exact:true})).toHaveValue('系统底座');
});

test('a linked viewer can coordinate and read groups without receiving management permission',async({page,fixture})=>{
 const issued=await fixture.app.inject({method:'POST',url:'/api/v1/admin/users',headers:headers(fixture),payload:{username:'group.viewer',name:'分组只读成员',systemRole:'user',canCreateProjects:false}});expect(issued.statusCode).toBe(200);const credential=issued.json().data;
 fixture.db.prepare('UPDATE auth_users SET must_change_password=0 WHERE id=?').run(credential.user.id);fixture.db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','xu',credential.user.id);
 const w=await state(fixture);const response=await fixture.app.inject({method:'POST',url:'/api/v1/projects/phase-one/workstreams',headers:headers(fixture),payload:{expectedVersion:w.version,expectedPlanVersion:w.planVersion,reason:'只读成员协调但不授予写权限',workstream:{name:'只读协调分组',description:'',ownerId:'xu',color:'cyan'}}});expect(response.statusCode,response.body).toBe(200);
 await login(page,'group.viewer',credential.initialPassword);await expect(page.getByTestId('workstream-row').filter({hasText:'只读协调分组'})).toBeVisible();await expect(page.getByRole('button',{name:'＋ 新增工作分组',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'编辑只读协调分组',exact:true})).toHaveCount(0);await expect(page.locator('.wg-page')).toContainText('当前为只读查看');
});

for (const width of [1440,390,320]) test(`workgroup list and confirmations fit ${width}px`,async({page},testInfo)=>{
 await page.setViewportSize({width,height:width===1440?900:844});await login(page);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`workgroups-${width}.png`),fullPage:true,animations:'disabled'});
 await page.getByRole('button',{name:'下移系统底座',exact:true}).click();
 const moveDialog=page.getByRole('dialog');await expect(moveDialog.getByRole('button',{name:'确认下移',exact:true})).toBeVisible();await expect(moveDialog.getByLabel('操作原因',{exact:true})).toHaveCount(0);
 expect(await moveDialog.evaluate(element=>element.scrollWidth<=element.clientWidth)).toBe(true);
 const bounds=await moveDialog.boundingBox();expect(bounds!.x).toBeGreaterThanOrEqual(0);expect(bounds!.x+bounds!.width).toBeLessThanOrEqual(width);expect(bounds!.y+bounds!.height).toBeLessThanOrEqual(width===1440?900:844);
 await page.screenshot({path:testInfo.outputPath(`workgroup-move-confirm-${width}.png`),animations:'disabled'});await moveDialog.getByRole('button',{name:'取消',exact:true}).click();
 await page.getByRole('button',{name:'＋ 新增工作分组',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('工作分组名称',{exact:true})).toBeVisible();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.getByLabel('工作分组名称',{exact:true}).fill('窄屏验收分组');await expect(page.getByLabel('操作原因',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'核对变更',exact:true}).click();await expect(page.getByRole('button',{name:'确认保存',exact:true})).toBeVisible();await page.screenshot({path:testInfo.outputPath(`workgroup-confirm-${width}.png`),animations:'disabled'});
 page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'关闭工作分组表单',exact:true}).click();await page.getByRole('button',{name:'停用系统底座',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('项未完成');expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`workgroup-disable-${width}.png`),animations:'disabled'});
});

test('switching projects retains the workgroups module and each project filter',async({page,fixture})=>{
 const response=await fixture.app.inject({method:'POST',url:'/api/v1/projects',headers:headers(fixture),payload:{name:'分组切换项目',goal:'工作分组上下文验证',start:'2026-10-01',end:'2026-12-31'}});expect(response.statusCode,response.body).toBe(200);const projectId=response.json().data.id;
 await login(page);await page.getByLabel('搜索工作分组',{exact:true}).fill('系统');await page.getByRole('button',{name:'切换项目',exact:true}).click();await page.getByRole('button',{name:/分组切换项目/}).click();await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/workstreams$`));await expect(page.getByLabel('搜索工作分组',{exact:true})).toHaveValue('');await expect(page.getByTestId('workstream-row')).toHaveCount(1);await expect(page.getByTestId('workstream-row')).toContainText('通用工作');
 await page.getByLabel('搜索工作分组',{exact:true}).fill('通用');await page.getByRole('button',{name:'切换项目',exact:true}).click();await page.getByRole('button',{name:/我有好活示例项目/}).click();await expect(page).toHaveURL(/\/projects\/phase-one\/workstreams$/);await expect(page.getByLabel('搜索工作分组',{exact:true})).toHaveValue('系统');await expect(page.getByTestId('workstream-row')).toHaveCount(1);
});
