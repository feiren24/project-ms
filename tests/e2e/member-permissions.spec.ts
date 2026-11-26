import { test as base, expect, type Page, type BrowserContext } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { buildApp } from '../../server/src/app.js';
import { hashPassword } from '../../server/src/modules/auth/passwords.js';
import { issueSession, publicUser, userById } from '../../server/src/modules/auth/store.js';
import type { ProjectRole } from '../../shared/src/permissions.js';

const now = new Date('2026-09-08T03:00:00Z');
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'goodwork-member-permissions-'));
  const path = join(directory, 'fixture.sqlite');
  const app = buildApp({allowedOrigins:[process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174','http://127.0.0.1:5174'], dbPath: path, clock: () => now, snapshotIntervalMs: 0, riskIntervalMs: 0, jobIntervalMs: 0, secureCookies: false });
  await app.ready();
  const db = new Database(path), password = await hashPassword('Isolated-member-browser-2026');
  const roles: Record<string, ProjectRole> = { owner: 'manager', admin: 'project_admin', member: 'member', viewer: 'viewer', spare: 'member' };
  for (const [id, role] of Object.entries(roles)) {
    db.prepare('INSERT INTO auth_users VALUES(?,?,?,\'user\',1,0,0,1,?,?,?)').run(id, id, `测试${id}`, password, now.toISOString(), now.toISOString());
    db.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(\'phase-one\',?,?,?,1)').run(id, `测试${id}`, role);
    db.prepare('INSERT INTO project_user_links VALUES(\'phase-one\',?,?)').run(id, id);
  }
  db.prepare('INSERT INTO auth_users VALUES(\'candidate\',\'candidate\',\'候选测试成员\',\'user\',1,0,0,1,?,?,?)').run(password, now.toISOString(), now.toISOString());
  async function session(id: string) { return issueSession(db, publicUser(userById(db,id)!), now); }
  async function api(id: string, suffix: string, method: 'GET'|'POST'|'PATCH' = 'GET', payload?: unknown) {
    const login = await session(id);
    const response = await app.inject({ method, url: `/api/v1/projects/phase-one${suffix}`, headers: { cookie: `goodwork_session=${login.token}`, 'x-csrf-token': login.record.csrfToken, 'idempotency-key': crypto.randomUUID() }, payload });
    expect(response.statusCode, response.body).toBe(200); return response.json().data;
  }
  return { app, db, session, api, async close() { await app.close(); db.close(); await rm(directory,{recursive:true,force:true}); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const test = base.extend<{ system: Fixture }>({
  system: async ({}, use) => { const system = await fixture(); try { await use(system); } finally { await system.close(); } },
  context: async ({context,system},use) => {
    await context.route('**/api/v1/**', async route => {
      const request=route.request(), url=new URL(request.url());
      const response=await system.app.inject({method:request.method() as 'GET'|'POST'|'PATCH',url:url.pathname+url.search,headers:await request.allHeaders(),payload:request.postData()||undefined});
      await route.fulfill({status:response.statusCode,headers:Object.fromEntries(Object.entries(response.headers).filter(([key])=>!['content-length','transfer-encoding','connection'].includes(key)).map(([key,value])=>[key,Array.isArray(value)?value.join('\n'):String(value)])),body:response.body});
    });
    await use(context); await context.unrouteAll({behavior:'wait'});
  },
});
async function enter(context:BrowserContext,page:Page,system:Fixture,id:string,path='tasks') {
  const login=await system.session(id);
  await context.clearCookies(); await context.addCookies([{name:'goodwork_session',value:login.token,url:process.env.PLAYWRIGHT_BASE_URL||'http://127.0.0.1:5174',httpOnly:true,sameSite:'Strict'}]);
  await page.goto(`/projects/phase-one/${path}`);
  await expect(page.getByRole('heading',{name:path==='settings'?'成员与设置':'任务管理',exact:true})).toBeVisible();
}
async function createTask(system:Fixture,extra:Record<string,unknown>={}) {
  const ws=await system.api('admin','/tasks');
  return (await system.api('admin','/tasks','POST',{expectedPlanVersion:ws.planVersion,title:'权限测试交付',description:'',workstreamId:'system-bottom',parentId:null,ownerId:'member',priority:'P1',effortHours:8,requiresReview:false,reviewerId:null,acceptanceCriteria:'',evidence:'',start:null,end:null,...extra})).task;
}
async function transition(system:Fixture,id:string,taskId:string,action:string) {
  const ws=await system.api(id,'/tasks'),task=ws.tasks.find((t:{id:string})=>t.id===taskId);
  return system.api(id,`/tasks/${taskId}/transition`,'POST',{expectedPlanVersion:ws.planVersion,expectedVersion:task.version,action,reason:'隔离测试进展',...(action==='submit'?{evidence:'已验证交付材料'}:{})});
}

test('member creates fully specified task, assigns another member and only selects summary parents',async({page,context,system})=>{
  await enter(context,page,system,'member');
  await page.getByRole('button',{name:'新建任务',exact:true}).click();
  await page.getByLabel('任务名称').fill('成员创建并分派的任务');
  await expect(page.getByLabel('负责人',{exact:true})).toHaveValue('member');
  await page.getByLabel('负责人',{exact:true}).selectOption('spare');
  await page.getByLabel('优先级',{exact:true}).selectOption('P0');
  await page.getByLabel('预计工时（小时）').fill('12');
  await expect(page.getByRole('button',{name:'管理工作分组',exact:true})).toHaveCount(0);
  const parentOptions=await page.getByLabel('父任务（可选）',{exact:true}).locator('option').allTextContents();
  expect(parentOptions.length).toBe(1); // no summaries in this isolated seed, cannot convert others' tasks
  await page.getByRole('button',{name:'创建任务',exact:true}).click();
  await expect(page.getByRole('heading',{name:'成员创建并分派的任务',exact:true})).toBeVisible();
  const ws=await system.api('member','/tasks'),created=ws.tasks.find((t:{title:string})=>t.title==='成员创建并分派的任务');
  expect(created).toMatchObject({ownerId:'spare',priority:'P0',effortHours:12});
  await page.goto(`/projects/phase-one/tasks/${created.id}`);
  await expect(page.getByRole('button',{name:'编辑任务',exact:true})).toHaveCount(0);
});

for(const width of [1440,390,320]) test(`administrator adds, edits, removes and restores members at ${width}px`,async({page,context,system},info)=>{
  await page.setViewportSize({width,height:900}); await enter(context,page,system,'admin','settings');
  await page.getByRole('button',{name:'添加项目成员',exact:true}).click();
  const add=page.getByRole('dialog',{name:'添加项目成员',exact:true});
  await add.getByLabel('登录账号',{exact:true}).selectOption('candidate');
  await expect(add.getByLabel('项目角色',{exact:true}).locator('option')).toHaveCount(4);
  await add.getByLabel('项目角色',{exact:true}).selectOption('project_admin');
  await add.getByLabel('操作原因',{exact:true}).fill('添加协作管理员');
  await add.getByRole('button',{name:'核对成员信息',exact:true}).click();
  await add.getByRole('button',{name:'确认添加成员',exact:true}).click();
  const row=page.getByTestId('member-row').filter({hasText:'候选测试成员'});
  await expect(row).toContainText('项目管理员');
  await row.getByRole('button',{name:'编辑成员 候选测试成员'}).click();
  await page.getByLabel('成员角色',{exact:true}).selectOption('member');
  await page.getByLabel('变更原因',{exact:true}).fill('调整为项目成员');
  await page.getByRole('button',{name:'核对变更',exact:true}).click(); await page.getByRole('button',{name:'确认保存',exact:true}).click();
  await expect(row).toContainText('项目成员');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.evaluate(() => window.scrollTo(0,0));
  await page.screenshot({path:info.outputPath(`members-${width}.png`)});
  await row.getByRole('button',{name:'移除成员 候选测试成员'}).click();
  await expect(page.getByText('没有待移交事项，可以移除。提交时会再次检查最新责任。')).toBeVisible();
  await page.getByLabel('移除原因',{exact:true}).fill('本阶段协作结束');
  await page.screenshot({path:info.outputPath(`remove-${width}.png`)});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.getByRole('button',{name:'确认移除成员',exact:true}).click(); await expect(row).toHaveCount(0);
  const original=system.db.prepare("SELECT member_id FROM project_user_links WHERE user_id='candidate'").get() as {member_id:string};
  await page.getByLabel('成员范围',{exact:true}).selectOption('removed'); await expect(row).toContainText('已移除');
  await page.getByRole('button',{name:'添加项目成员',exact:true}).click(); await add.getByLabel('登录账号',{exact:true}).selectOption('candidate');
  await expect(add).toContainText('恢复'); await expect(add.getByLabel('操作原因',{exact:true})).toHaveCount(0);
  await add.getByRole('button',{name:'核对成员信息',exact:true}).click(); await add.getByRole('button',{name:'确认添加成员',exact:true}).click();
  await page.getByLabel('成员范围',{exact:true}).selectOption('current'); await expect(row).toContainText('项目成员');
  expect(system.db.prepare("SELECT member_id FROM project_user_links WHERE user_id='candidate'").get()).toEqual(original);
});

test('viewer can browse every module but cannot create, export, mark read or manage members',async({page,context,system})=>{
  await enter(context,page,system,'viewer'); await expect(page.getByRole('button',{name:'新建任务',exact:true})).toBeDisabled();
  for(const [path,forbidden] of [['plan','导出计划'],['analytics','导出当前分析'],['settings','添加项目成员']] as const){
    await page.goto(`/projects/phase-one/${path}`); await expect(page.locator('h1')).toBeVisible();
    await expect(page.getByRole('button',{name:forbidden,exact:true})).toHaveCount(0);
    if(path==='analytics'){await page.getByRole('button',{name:'人员任务分析',exact:true}).click();await expect(page.getByTestId('personnel-total')).toBeVisible();}
    if(path==='plan') await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toHaveCount(0);
  }
  await page.getByRole('button',{name:/站内通知/}).first().click();
  await expect(page.getByRole('heading',{name:'站内通知',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'全部标为已读',exact:true})).toHaveCount(0);
});

test('plan ordering uses real project permission and preserves draft when administrator loses access',async({page,context,system})=>{
  await enter(context,page,system,'member');await page.goto('/projects/phase-one/plan');
  await expect(page.getByRole('heading',{name:'完整计划',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'调整顺序',exact:true})).toHaveCount(0);
  await enter(context,page,system,'admin');await page.goto('/projects/phase-one/plan');
  await page.getByRole('button',{name:'调整顺序',exact:true}).click();await page.getByRole('button',{name:'展开全部',exact:true}).click();
  await page.locator('.gantt-row[data-node-id="task-002"] .gantt-name-button').click();await page.getByRole('button',{name:'上移',exact:true}).click();
  const before=await system.api('owner','/gantt');
  system.db.prepare("UPDATE project_members SET role='member' WHERE project_id='phase-one' AND id='admin'").run();
  await page.getByRole('button',{name:'保存顺序',exact:true}).click();
  await expect(page.getByRole('alert')).toContainText('草稿已保留');await expect(page.getByRole('button',{name:'保存顺序',exact:true})).toBeDisabled();
  expect((await system.api('owner','/gantt')).siblingOrders).toEqual(before.siblingOrders);
});

test('removal lists blocking responsibilities and navigates to task',async({page,context,system})=>{
  const task=await createTask(system); await enter(context,page,system,'admin','settings');
  await page.getByRole('button',{name:'移除成员 测试member',exact:true}).click();
  await expect(page.getByRole('dialog')).toContainText('权限测试交付');
  await page.getByLabel('移除原因',{exact:true}).fill('有职责时不能移除');
  await expect(page.getByRole('button',{name:'确认移除成员',exact:true})).toBeDisabled();
  page.once('dialog',dialog=>dialog.accept()); await page.getByRole('button',{name:'查看事项',exact:true}).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${task.id}$`));
});

test('administrator self-review is explicit and records actual reviewer',async({page,context,system})=>{
  const task=await createTask(system,{ownerId:'admin',requiresReview:true,reviewerId:'spare',acceptanceCriteria:'通过场景核验'});
  await transition(system,'admin',task.id,'start'); await transition(system,'admin',task.id,'submit');
  await enter(context,page,system,'admin'); await page.goto(`/projects/phase-one/tasks/${task.id}`);
  await page.getByRole('button',{name:'验收通过',exact:true}).click();
  await expect(page.getByText('你正在验收自己负责或提交的成果。请填写自验理由，确认后记录实际操作者和自验身份。')).toBeVisible();
  await page.getByRole('textbox',{name:/自验依据/}).fill('管理员已复核本次成果，自验留痕');
  await page.getByRole('button',{name:'确认验收通过',exact:true}).click();
  const ws=await system.api('admin','/tasks'),done=ws.tasks.find((t:{id:string})=>t.id===task.id);
  expect(done.submissions.at(-1)).toMatchObject({reviewerId:'spare',reviewedById:'admin',selfReview:true,status:'accepted'});
  await page.goto(`/projects/phase-one/tasks/${task.id}`); await page.getByRole('tab',{name:'活动记录',exact:true}).click();
  await expect(page.getByText('实际验收：测试admin · 管理员自验')).toBeVisible();
});

test('removed signed-in member loses page and returns to project directory',async({page,context,system})=>{
  await enter(context,page,system,'spare'); const preview=await system.api('admin','/memberships/spare/removal-preview');
  await system.api('admin','/memberships/spare/remove','POST',{expectedVersion:preview.version,expectedPlanVersion:preview.planVersion,reason:'撤销项目访问'});
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.getByRole('heading', {name:'还没有可访问的项目', exact:true})).toBeVisible();
});

for (const [module, buttonName] of [['plan', '导出计划'], ['analytics', '导出当前分析']] as const) test(`existing ${module} page rechecks export after member becomes viewer`, async ({page,context,system}) => {
  await enter(context,page,system,'spare');
  await page.goto(`/projects/phase-one/${module}`);
  if(module==='analytics') await page.getByRole('button',{name:'人员任务分析',exact:true}).click();
  const button = page.getByRole('button',{name:buttonName,exact:true}); await expect(button).toBeEnabled();
  const settings = await system.api('admin','/settings');
  await system.api('admin','/settings/member_update','POST',{expectedVersion:settings.version,expectedPlanVersion:settings.planVersion,reason:'调整为只读角色',member:{id:'spare',name:'测试spare',role:'viewer',active:true}});
  const downloads: string[] = []; page.on('download',download => downloads.push(download.suggestedFilename()));
  await button.click();
  await expect(page.getByText('当前角色仅可浏览项目，不能导出数据。',{exact:true})).toBeVisible();
  await expect(button).toHaveCount(0); expect(downloads).toEqual([]);
});
