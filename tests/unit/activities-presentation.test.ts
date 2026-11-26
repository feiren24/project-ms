import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from '../../client/src/stores/auth';
import { beforeEach, describe, expect, it } from 'vitest';
import { activityTime, activityRoute } from '../../client/src/features/activities/presentation';
describe('activity presentation',()=>{
 beforeEach(()=>setActivePinia(createPinia()));
 it('uses Shanghai midnight and a fixed time range',()=>{
  const now=new Date('2026-09-08T16:30:00Z');
  expect(activityTime('2026-09-08T16:10:00Z','2026-09-08T16:18:00Z',now)).toBe('今天 00:10–00:18');
  expect(activityTime('2026-09-08T15:59:00Z',undefined,now)).toBe('昨天 23:59');
  expect(activityTime('2026-09-01T00:00:00Z',undefined,now)).toBe('2026-09-01 08:00');
 });
 it('binds target navigation to exact project and record, with no unknown fallback',()=>{
  expect(activityRoute({kind:'task',id:'t1',name:'旧任务'},'project-b')).toEqual({name:'task-detail',params:{projectId:'project-b',taskId:'t1'}});
  expect(activityRoute({kind:'baseline',id:'b1',name:'基线'},'p')).toEqual({name:'plan',params:{projectId:'p'},query:{view:'gantt',baseline:'b1'}});
  expect(activityRoute({kind:'milestone',id:'m1',name:'交付节点'},'p')).toEqual({name:'plan',params:{projectId:'p'},query:{view:'milestones',milestone:'m1'}});
  expect(activityRoute({kind:'unknown',id:'x',name:'未知'},'p')).toBeNull();
 });
 it('management targets are hidden for members while task and plan links remain available',()=>{
  const auth=useAuthStore();
  auth.session={user:null,csrfToken:'',initialized:true,projects:[{id:'p',name:'协作项目',memberId:'member',role:'member',capabilities:{analytics:false,risks:false,settings:false}}]};
  for(const kind of ['risk','member','calendar','project']) expect(activityRoute({kind,id:'private',name:'管理记录'},'p')).toBeNull();
  expect(activityRoute({kind:'workstream',id:'w1',name:'工作分组'},'p')).toEqual({name:'workstreams',params:{projectId:'p'},query:{groupId:'w1'}});
  expect(activityRoute({kind:'task',id:'t1',name:'团队任务'},'p')).toEqual({name:'task-detail',params:{projectId:'p',taskId:'t1'}});
  auth.updateCapabilities('p',{analytics:true,risks:true,settings:true});
  expect(activityRoute({kind:'risk',id:'r1',name:'风险'},'p')).toEqual({name:'risk-detail',params:{projectId:'p',riskId:'r1'}});
  expect(activityRoute({kind:'member',id:'m1',name:'成员配置'},'p')).toEqual({name:'settings',params:{projectId:'p'}});
 });

});
