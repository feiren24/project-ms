import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { beforeEach, afterEach, test, expect } from 'vitest';
import { buildLegacyApp } from '../helpers/legacy-app.js';
import type { ManagedTask, TaskDraft, TaskWorkspace } from '../../shared/src/tasks.js';

let app: ReturnType<typeof buildLegacyApp>, db: Database.Database, directory: string;
const base = '/api/v1/projects/phase-one/tasks';
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'task-workstream-'));
  const dbPath = join(directory, 'test.sqlite');
  app = buildLegacyApp({ dbPath, jobIntervalMs: 0, snapshotIntervalMs: 0, riskIntervalMs: 0 });
  db = new Database(dbPath);
});
afterEach(async () => { await app.close(); db.close(); await rm(directory, { recursive: true, force: true }); });
async function workspace(actor = 'zhou'): Promise<TaskWorkspace> { return (await app.inject({url: base, headers: {'x-demo-actor': actor}})).json().data; }
async function request(path: string, payload: object, actor = 'zhou', method: 'POST'|'PATCH' = 'POST', key = randomUUID()) {
  const w = await workspace();
  return app.inject({method, url: base + path, payload, headers: {'x-demo-actor': actor, 'x-preview-token': w.writeToken, 'idempotency-key': key}});
}
function draft(t: ManagedTask): TaskDraft { return Object.fromEntries(['title','description','workstreamId','parentId','ownerId','priority','effortHours','requiresReview','reviewerId','acceptanceCriteria','evidence'].map(k => [k,t[k as keyof ManagedTask]])) as unknown as TaskDraft; }
async function create(parentId: string|null = null) {
  const w = await workspace();
  const r = await request('', {title: '虚构迁移任务', description: '', workstreamId: 'system-bottom', parentId, ownerId: 'chen', priority: 'P1', effortHours: null, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', expectedPlanVersion: w.planVersion});
  expect(r.statusCode,r.body).toBe(200); return r.json().data.task as ManagedTask;
}
function meta(id: string, values: object) { db.prepare('UPDATE task_meta SET meta_json=json_patch(meta_json,?) WHERE task_id=?').run(JSON.stringify(values),id); }
async function preview(id: string, target = 'b-side') { const r = await request(`/${id}/workstream-preview`, {workstreamId:target}); expect(r.statusCode,r.body).toBe(200); return r.json().data; }
async function payload(id: string, token?: string, edits: object = {}) {
  const w = await workspace(), t = w.tasks.find(t=>t.id===id)!;
  return {...draft(t), expectedVersion:t.version, expectedPlanVersion:w.planVersion, expectedStructureVersion:w.structureVersion, workstreamId:'b-side', ...(token === undefined ? {} : {workstreamPreviewToken:token}), ...edits};
}
function snapshot() { return ['plan_projects','homepage_tasks','task_meta','plan_order_projects','task_idempotency','task_recycle','plan_history','activity_groups','background_jobs'].map(table=>db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()); }
async function tree() {
  const root = await create(); meta(root.id,{taskKind:'summary'});
  const children = [];
  for (const state of ['todo','done','cancelled','submitted']) {
    const child = await create(root.id); children.push(child);
    if(state==='done') db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id=?").run(child.id);
    if(state==='cancelled') meta(child.id,{cancelled:true});
    if(state==='submitted') meta(child.id,{reviewStatus:'submitted',requiresReview:true,reviewerId:'lin',submissions:[{id:'historical-submission',status:'submitted'}]});
  }
  return {root,children};
}
test('moves every live descendant, appends root, preserves identity/schedule/review and internal order', async () => {
  const {root,children} = await tree(), before = await workspace();
  const orderBefore = JSON.parse((db.prepare("SELECT orders_json FROM plan_order_projects WHERE project_id='phase-one'").get() as any).orders_json);
  const p = await preview(root.id); expect(p).toMatchObject({workstreamId:'b-side',sourceWorkstreamId:'system-bottom'});
  expect(p.tasks.map((t:ManagedTask)=>t.id).sort()).toEqual([root.id,...children.map(t=>t.id)].sort());
  expect(p.tasks.map((t:ManagedTask)=>t.status)).toEqual(expect.arrayContaining(['done','cancelled']));
  const planBefore = db.prepare("SELECT nodes_json,dependencies_json FROM plan_projects WHERE project_id='phase-one'").get() as any;
  const r = await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH'); expect(r.statusCode,r.body).toBe(200);
  const after = await workspace(), nodes = JSON.parse((db.prepare("SELECT nodes_json FROM plan_projects WHERE project_id='phase-one'").get() as any).nodes_json);
  for (const id of [root.id,...children.map(t=>t.id)]) {
    const old = before.tasks.find(t=>t.id===id)!, current = after.tasks.find(t=>t.id===id)!;
    expect(current).toMatchObject({...Object.fromEntries(['id','wbs','parentId','ownerId','start','end','actualStart','actualEnd','effortHours','status','reviewStatus','submissions','progress'].map(k=>[k,old[k as keyof ManagedTask]])),workstreamId:'b-side',version:old.version+1});
    const node = nodes.find((n:any)=>n.id===id), oldNode = JSON.parse(planBefore.nodes_json).find((n:any)=>n.id===id);
    expect(node).toEqual({...oldNode,workstreamId:'b-side',color:after.workstreams.find(w=>w.id==='b-side')!.color,parentId:id===root.id?'group-b-side':oldNode.parentId});
    expect(current.events.at(-1)?.action).toBe('workstream_change');
  }
  expect((db.prepare("SELECT dependencies_json FROM plan_projects WHERE project_id='phase-one'").get() as any).dependencies_json).toBe(planBefore.dependencies_json);
  const orderAfter = JSON.parse((db.prepare("SELECT orders_json FROM plan_order_projects WHERE project_id='phase-one'").get() as any).orders_json);
  expect(orderAfter.find((o:any)=>o.parentId===root.id)).toEqual(orderBefore.find((o:any)=>o.parentId===root.id));
  expect(orderAfter.find((o:any)=>o.parentId==='group-b-side').nodeIds.at(-1)).toBe(root.id);
  expect(after.structureVersion).toBeGreaterThan(before.structureVersion!);
});
test.each(['chen','lin','missing'])('only actual managers may preview or patch: %s',async actor=>{
  const t=await create(), p=await preview(t.id), before=snapshot();
  expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'b-side'},actor)).statusCode).toBe(403);
  expect((await request(`/${t.id}`,await payload(t.id,p.previewToken),actor,'PATCH')).statusCode).toBe(403);
  expect((await workspace(actor)).canChangeWorkstream).toBe(false); expect(snapshot()).toEqual(before);
});
test('project_admin is allowed and permissions are rechecked before receipt replay',async()=>{
  db.prepare("UPDATE project_members SET role='project_admin' WHERE id='zhou'").run();
  const t=await create(),p=await preview(t.id),body=await payload(t.id,p.previewToken),key=randomUUID();
  const first=await request(`/${t.id}`,body,'zhou','PATCH',key);expect(first.statusCode,first.body).toBe(200);
  expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).json()).toEqual(first.json());
  db.prepare("UPDATE project_members SET role='member' WHERE id='zhou'").run();
  expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).statusCode).toBe(403);
});
test('child cannot move independently, even combined with removing its parent',async()=>{
  const {children}=await tree();const t=children[0];
  expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'b-side'})).statusCode).toBe(422);
  expect((await request(`/${t.id}`,await payload(t.id,'forged',{parentId:null}),'zhou','PATCH')).statusCode).toBe(422);
});
test.each(['missing','forged'])('a differing legacy PATCH cannot bypass preview: %s',async mode=>{
  const t=await create(),before=snapshot();const r=await request(`/${t.id}`,await payload(t.id,mode==='missing'?undefined:'forged'),'zhou','PATCH');
  expect([409,422]).toContain(r.statusCode);expect(snapshot()).toEqual(before);
});
test.each(['descendant','new-child','target','source','order'])('preview binds %s changes',async change=>{
  const {root,children}=await tree(),p=await preview(root.id);
  if(change==='descendant')meta(children[0].id,{version:99});
  if(change==='new-child')await create(root.id);
  if(change==='target'||change==='source')db.prepare('UPDATE workstreams SET version=version+1 WHERE id=?').run(change==='target'?'b-side':'system-bottom');
  if(change==='order')db.prepare('UPDATE plan_order_projects SET version=version+1').run();
  const before=snapshot(),r=await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH');
  expect(r.statusCode,r.body).toBe(409);expect(snapshot()).toEqual(before);
});
test('valid normal edits and move commit together; invalid edits roll back everything',async()=>{
  const t=await create(),p=await preview(t.id),before=snapshot();
  const bad=await request(`/${t.id}`,await payload(t.id,p.previewToken,{ownerId:'missing'}),'zhou','PATCH');expect(bad.statusCode).toBe(422);expect(snapshot()).toEqual(before);
  const good=await request(`/${t.id}`,await payload(t.id,p.previewToken,{title:'变更标题',description:'变更说明'}),'zhou','PATCH');expect(good.statusCode,good.body).toBe(200);expect(good.json().data.task).toMatchObject({title:'变更标题',description:'变更说明',workstreamId:'b-side'});
});
test.each(['summary','done','cancelled','submitted'])('%s permits only workstream differences',async state=>{
  const t=await create();
  if(state==='summary')meta(t.id,{taskKind:'summary'});
  if(state==='done')db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id=?").run(t.id);
  if(state==='cancelled')meta(t.id,{cancelled:true});
  if(state==='submitted')meta(t.id,{reviewStatus:'submitted'});
  const p=await preview(t.id),before=snapshot();
  for(const edit of [{title:'不能修改'},{description:'不能修改'},{evidence:'不能修改'},{parentId:'task-001'}]) {
    const bad=await request(`/${t.id}`,await payload(t.id,p.previewToken,edit),'zhou','PATCH');expect(bad.statusCode,bad.body).toBe(422);expect(snapshot()).toEqual(before);
  }
  const good=await request(`/${t.id}`,await payload(t.id,p.previewToken),'zhou','PATCH');expect(good.statusCode,good.body).toBe(200);
});
test('old drafts cannot revert a moved descendant even with current structure version',async()=>{
  const {root,children}=await tree(),old=await payload(children[0].id,undefined,{workstreamId:'system-bottom'}),p=await preview(root.id);
  expect((await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(200);
  const w=await workspace(),r=await request(`/${children[0].id}`,{...old,expectedStructureVersion:w.structureVersion,expectedPlanVersion:w.planVersion},'zhou','PATCH');expect(r.statusCode).toBe(409);
});
test('deleted child follows live parent on restore with notice while audit snapshot remains immutable',async()=>{
  const {root,children}=await tree(),child=children[0];
  const del=await request(`/${child.id}/delete-preview`,{});expect(del.statusCode,del.body).toBe(200);
  expect((await request(`/${child.id}/delete`,{previewToken:del.json().data.previewToken,reason:'误删'})).statusCode).toBe(200);
  const archive=()=>db.prepare('SELECT snapshot_json FROM task_recycle WHERE task_id=?').get(child.id);
  const original=archive(),p=await preview(root.id);expect(p.tasks.some((t:ManagedTask)=>t.id===child.id)).toBe(false);
  expect((await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(200);expect(archive()).toEqual(original);
  db.prepare("UPDATE workstreams SET active=0 WHERE id='system-bottom'").run();
  const restore=await request(`/deleted/${child.id}/restore-preview`,{});expect(restore.statusCode,restore.body).toBe(200);
  expect(restore.json().data).toMatchObject({blockers:[],workstreamChange:{fromId:'system-bottom',toId:'b-side',fromName:expect.any(String),toName:expect.any(String)}});
  const r=await request(`/deleted/${child.id}/restore`,{previewToken:restore.json().data.previewToken,reason:'恢复原任务'});expect(r.statusCode,r.body).toBe(200);
  expect((await workspace()).tasks.find(t=>t.id===child.id)).toMatchObject({workstreamId:'b-side',parentId:root.id,wbs:child.wbs});expect(archive()).toEqual(original);
  const node=JSON.parse((db.prepare("SELECT nodes_json FROM plan_projects WHERE project_id='phase-one'").get() as any).nodes_json).find((n:any)=>n.id===child.id);expect(node.workstreamId).toBe('b-side');
});
test.each(['summary','done','cancelled','submitted'])('classification-only preserves grandfathered invalid fields on %s',async state=>{
  const t=await create();
  meta(t.id,{ownerId:'retired-owner',reviewerId:'retired-reviewer',requiresReview:true,acceptanceCriteria:'',evidence:'historical data:link',...(state==='summary'?{taskKind:'summary'}:{}),...(state==='cancelled'?{cancelled:true}:{}),...(state==='submitted'?{reviewStatus:'submitted'}:{})});
  if(state==='done')db.prepare("UPDATE homepage_tasks SET status='done',progress=100 WHERE id=?").run(t.id);
  const p=await preview(t.id),r=await request(`/${t.id}`,await payload(t.id,p.previewToken),'zhou','PATCH');expect(r.statusCode,r.body).toBe(200);
  expect(r.json().data.task).toMatchObject({ownerId:'retired-owner',reviewerId:'retired-reviewer',requiresReview:true,acceptanceCriteria:'',evidence:'historical data:link'});
});
test.each(['inactive','removed'])('%s project manager cannot preview, patch, replay or advertise capability',async condition=>{
  const t=await create(),p=await preview(t.id),body=await payload(t.id,p.previewToken),key=randomUUID();expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).statusCode).toBe(200);
  db.prepare(condition==='inactive'?"UPDATE project_members SET active=0 WHERE id='zhou'":"UPDATE project_members SET removed_at='2026-09-11' WHERE id='zhou'").run();
  expect((await workspace()).canChangeWorkstream).toBe(false);
  expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'system-bottom'})).statusCode).toBe(403);
  expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).statusCode).toBe(403);
});
test('preview is read-only and rejects missing or inactive target and token reuse for another root',async()=>{
  const t=await create(),other=await create(),before=snapshot(),p=await preview(t.id);expect(snapshot()).toEqual(before);
  expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'missing'})).statusCode).toBe(422);
  expect((await request(`/${other.id}`,await payload(other.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(409);
  db.prepare("UPDATE workstreams SET active=0 WHERE id='b-side'").run();
  expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'b-side'})).statusCode).toBe(422);
  const changed=snapshot();expect((await request(`/${t.id}`,await payload(t.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(422);expect(snapshot()).toEqual(changed);
});
test('moving an execution root cannot also change parent hierarchy',async()=>{
  const t=await create(),parent=await create();meta(parent.id,{taskKind:'summary'});
  const parentPreview=await preview(parent.id);expect((await request(`/${parent.id}`,await payload(parent.id,parentPreview.previewToken),'zhou','PATCH')).statusCode).toBe(200);
  const p=await preview(t.id),before=snapshot(),r=await request(`/${t.id}`,await payload(t.id,p.previewToken,{parentId:parent.id}),'zhou','PATCH');expect(r.statusCode,r.body).toBe(422);expect(snapshot()).toEqual(before);
});
test('late write failure rolls back migration, normal edit, history, orders and receipt',async()=>{
  const t=await create(),p=await preview(t.id),before=snapshot();
  db.exec("CREATE TRIGGER fail_workstream_receipt BEFORE INSERT ON task_idempotency BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  const r=await request(`/${t.id}`,await payload(t.id,p.previewToken,{title:'不可保存'}),'zhou','PATCH');expect(r.statusCode).toBe(500);expect(snapshot()).toEqual(before);
});
test('restore preview becomes stale when parent moves again, and failed restore rolls back group application',async()=>{
  const {root,children}=await tree(),child=children[0],del=await request(`/${child.id}/delete-preview`,{});
  expect((await request(`/${child.id}/delete`,{previewToken:del.json().data.previewToken,reason:'误删'})).statusCode).toBe(200);
  let p=await preview(root.id);expect((await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(200);
  const restore=await request(`/deleted/${child.id}/restore-preview`,{});
  p=await preview(root.id,'system-bottom');expect((await request(`/${root.id}`,await payload(root.id,p.previewToken,{workstreamId:'system-bottom'}),'zhou','PATCH')).statusCode).toBe(200);
  let before=snapshot();expect((await request(`/deleted/${child.id}/restore`,{previewToken:restore.json().data.previewToken,reason:'恢复'})).statusCode).toBe(409);expect(snapshot()).toEqual(before);
  p=await preview(root.id);expect((await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH')).statusCode).toBe(200);
  const latest=await request(`/deleted/${child.id}/restore-preview`,{});before=snapshot();
  db.exec("CREATE TRIGGER fail_restore_receipt BEFORE INSERT ON task_recycle_receipts BEGIN SELECT RAISE(ABORT,'fixture rollback'); END;");
  expect((await request(`/deleted/${child.id}/restore`,{previewToken:latest.json().data.previewToken,reason:'恢复'})).statusCode).toBe(500);expect(snapshot()).toEqual(before);
});
test('authenticated global administrator needs an actual linked project management membership',async()=>{
  const {buildApp}=await import('../../server/src/app.js');const {createInitialAdmin}=await import('../../server/src/modules/auth/store.js');
  const t=await create();await app.close();app=buildApp({dbPath:join(directory,'test.sqlite'),jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0});
  await createInitialAdmin(db,{username:'stream-admin',name:'虚构系统管理员',password:'test-workstream-admin-2026'});
  const login=await app.inject({method:'POST',url:'/api/v1/auth/login',payload:{username:'stream-admin',password:'test-workstream-admin-2026'}});expect(login.statusCode).toBe(200);
  const session=login.json().data,headers={cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':session.csrfToken,'x-demo-actor':'zhou','idempotency-key':randomUUID()};
  const read=async(path='')=>(await app.inject({url:base+path,headers})).json().data;
  const post=(path:string,payload:object,method:'POST'|'PATCH'='POST')=>app.inject({url:base+path,headers,payload,method});
  const assertDenied=async()=>{
    for(const path of ['', '/options',`/${t.id}`,'/query'])expect((await read(path)).canChangeWorkstream).toBe(false);
    expect((await post(`/${t.id}/workstream-preview`,{workstreamId:'b-side'})).statusCode).toBe(403);
  };
  await assertDenied();
  db.prepare('INSERT INTO project_members(project_id,id,name,role,active) VALUES(?,?,?,?,1)').run('phase-one',session.user.id,'未关联同标识','manager');
  await assertDenied();db.prepare('DELETE FROM project_members WHERE id=?').run(session.user.id);
  db.prepare('INSERT INTO project_user_links VALUES(?,?,?)').run('phase-one','zhou',session.user.id);
  expect((await read('/options')).canChangeWorkstream).toBe(true);
  const p=await post(`/${t.id}/workstream-preview`,{workstreamId:'b-side'});expect(p.statusCode,p.body).toBe(200);
  const w=await read(),body={...draft(w.tasks.find((item:ManagedTask)=>item.id===t.id)),expectedVersion:t.version,expectedPlanVersion:w.planVersion,workstreamId:'b-side',workstreamPreviewToken:p.json().data.previewToken};
  expect((await post(`/${t.id}`,body,'PATCH')).statusCode).toBe(200);
  for(const role of ['member','viewer','project_admin']){
    db.prepare("UPDATE project_members SET role=? WHERE id='zhou'").run(role);
    expect((await read()).canChangeWorkstream).toBe(role==='project_admin');expect((await post(`/${t.id}`,body,'PATCH')).statusCode).toBe(role==='project_admin'?200:403);
  }
  db.prepare('UPDATE auth_users SET active=0 WHERE id=?').run(session.user.id);
  expect((await post(`/${t.id}`,body,'PATCH')).statusCode).toBe(401);
});
test('combined key deliverable owner change and move retain both activity records exactly once',async()=>{
  const t=await create();meta(t.id,{requiresReview:true,reviewerId:'zhou',acceptanceCriteria:'可核验成果'});
  const p=await preview(t.id),body=await payload(t.id,p.previewToken,{ownerId:'lin'}),key=randomUUID();
  const r=await request(`/${t.id}`,body,'zhou','PATCH',key);expect(r.statusCode,r.body).toBe(200);
  expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).json()).toEqual(r.json());
  expect(db.prepare("SELECT type,count(*) n FROM activity_groups WHERE type IN ('task.owner','task.workstream_change') GROUP BY type ORDER BY type").all()).toEqual([{type:'task.owner',n:1},{type:'task.workstream_change',n:1}]);
  const notifications=(db.prepare("SELECT payload_json FROM background_jobs WHERE kind='notification'").all() as Array<{payload_json:string}>).map(row=>JSON.parse(row.payload_json)).filter(p=>p.target?.id===t.id&&['task.update','task.workstream_change'].includes(p.kind));
  expect(new Set(notifications.map(p=>p.kind))).toEqual(new Set(['task.update','task.workstream_change']));
  expect(new Set(notifications.map(p=>`${p.eventKey}:${p.recipientId}`)).size).toBe(notifications.length);

});
test('existing-only database supports migration and durable replay without any schema migration',async()=>{
  const t=await create();
  const {buildApp}=await import('../../server/src/app.js');
  await app.close();app=buildApp({dbPath:join(directory,'test.sqlite'),jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0});await app.ready();
  const schema=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all();
  const before=schema();await app.close();app=buildLegacyApp({dbPath:join(directory,'test.sqlite'),databaseMode:'existing-only',jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0});
  const p=await preview(t.id),body=await payload(t.id,p.previewToken),key=randomUUID(),r=await request(`/${t.id}`,body,'zhou','PATCH',key);expect(r.statusCode,r.body).toBe(200);
  await app.close();app=buildLegacyApp({dbPath:join(directory,'test.sqlite'),databaseMode:'existing-only',jobIntervalMs:0,snapshotIntervalMs:0,riskIntervalMs:0});
  expect((await request(`/${t.id}`,body,'zhou','PATCH',key)).json()).toEqual(r.json());expect(schema()).toEqual(before);
});
test('active target belonging only to another project is rejected',async()=>{
  const t=await create();
  db.prepare("INSERT INTO homepage_projects(id,snapshot_json) SELECT 'foreign-project',snapshot_json FROM homepage_projects WHERE id='phase-one'").run();
  db.prepare("INSERT INTO workstream_projects(project_id,version) VALUES('foreign-project',1)").run();
  db.prepare("INSERT INTO workstreams VALUES('foreign-project','foreign-group','外项目分组','',NULL,'blue',0,1,1)").run();
  const before=snapshot();expect((await request(`/${t.id}/workstream-preview`,{workstreamId:'foreign-group'})).statusCode).toBe(422);
  expect((await request(`/${t.id}`,await payload(t.id,'forged',{workstreamId:'foreign-group'}),'zhou','PATCH')).statusCode).toBe(422);expect(snapshot()).toEqual(before);
});
test('traversal includes descendants underneath a cancelled summary',async()=>{
  const {root,children}=await tree(),nested=children[2],leaf=children[0];
  meta(nested.id,{taskKind:'summary'});meta(leaf.id,{parentId:nested.id});
  const row=db.prepare("SELECT nodes_json FROM plan_projects WHERE project_id='phase-one'").get() as any,nodes=JSON.parse(row.nodes_json);
  nodes.find((n:any)=>n.id===leaf.id).parentId=nested.id;
  db.prepare("UPDATE plan_projects SET nodes_json=? WHERE project_id='phase-one'").run(JSON.stringify(nodes));
  const p=await preview(root.id);expect(p.tasks.map((t:ManagedTask)=>t.id)).toContain(leaf.id);
  const r=await request(`/${root.id}`,await payload(root.id,p.previewToken),'zhou','PATCH');expect(r.statusCode,r.body).toBe(200);
  const w=await workspace();expect(w.tasks.find(t=>t.id===leaf.id)).toMatchObject({workstreamId:'b-side',parentId:nested.id});expect(w.tasks.find(t=>t.id===nested.id)).toMatchObject({workstreamId:'b-side',status:'cancelled'});
});
