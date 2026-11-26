import { describe, expect, test } from 'vitest';
import type { ManagedTask, TaskEvent } from '../../shared/src/tasks.js';
import type { PlanBaseline, PlanNode, ProjectPlan } from '../../shared/src/planning.js';
import type { RiskRuleInput, RiskRuleKey } from '../../shared/src/risks.js';
import { evaluateRiskRules, scoreRisk } from '../../server/src/modules/risks/rules.js';
const task = (extra: Partial<ManagedTask> = {}): ManagedTask => ({
  id:'a',wbs:'1',workstreamId:'w',parentId:null,title:'执行任务',description:'DEMO',ownerId:'owner',owner:'演示成员',priority:'P0',
  status:'todo',progress:0,start:'2026-09-07',end:'2026-09-11',effortHours:40,blocked:false,blockReason:'',requiresReview:false,reviewerId:null,
  acceptanceCriteria:'验收',evidence:'',reviewStatus:'none',actualStart:null,actualEnd:null,version:1,createdAt:'2026-09-01T00:00:00Z',updatedAt:'2026-09-01T00:00:00Z',events:[],submissions:[],...extra,
});
const node = (extra: Partial<PlanNode> = {}): PlanNode => ({id:'a',parentId:null,workstreamId:'w',wbs:'1',kind:'task',title:'执行任务',description:'DEMO',owner:'演示成员',color:'blue',status:'todo',start:'2026-09-07',end:'2026-09-11',durationDays:5,effortHours:40,progress:0,blocked:false,...extra});
const plan = (extra: Partial<ProjectPlan> = {}): ProjectPlan => ({mode:'demo',project:{isDemo:true,id:'p',name:'DEMO',start:'2026-09-01',end:'2026-12-31',asOf:'2026-09-21'},planVersion:1,writeToken:'test',calendar:{weekdays:[1,2,3,4,5],hoursPerDay:8,confirmed:true,exceptions:{}},nodes:[node()],dependencies:[],baselines:[],issues:[],criticalIds:[],criticalCoverage:{complete:true,message:''},history:[],...extra});
const baseline = (entries: PlanBaseline['entries']): PlanBaseline => ({id:'b',name:'承诺',createdAt:'2026-09-01T00:00:00Z',actor:'DEMO',reason:'test',entries,dependencies:[],calendar:plan().calendar,excludedIds:[],demo:true});
const input = (extra: Partial<RiskRuleInput> = {}): RiskRuleInput => ({tasks:[task()],plan:plan(),today:'2026-09-14',...extra});
const hits = (data: RiskRuleInput, rule: RiskRuleKey) => evaluateRiskRules(data).candidates.filter(c => c.rule === rule);
const event = (action: string, createdAt: string): TaskEvent => ({id:createdAt,taskId:'a',actor:'DEMO',action,text:action,createdAt});
const milestonePlan = () => plan({nodes:[node(),node({id:'m',kind:'milestone',durationDays:0,start:'2026-09-11',end:'2026-09-11'})],dependencies:[{predecessorId:'a',successorId:'m',type:'FS',lagDays:0}]});

describe('risk manual scoring', () => {
  test.each([[1,1,1,'low'],[1,4,4,'low'],[1,5,5,'medium'],[3,3,9,'medium'],[2,5,10,'high'],[4,4,16,'high'],[4,5,20,'critical'],[5,5,25,'critical']])('scores %s × %s', (p,i,score,level) => expect(scoreRisk(p as number,i as number)).toEqual({score,level}));
  test('keeps unevaluated risk null and rejects partial or fabricated ratings', () => {
    expect(scoreRisk(null,null)).toEqual({score:null,level:null});
    for (const pair of [[null,1],[0,5],[1,6],[1.5,2],[NaN,2],[Infinity,2]] as const) expect(() => scoreRisk(pair[0],pair[1])).toThrow();
  });
});
describe('six automatic risk rules', () => {
  test('overdue means strictly past end; completed, cancelled and summary tasks are excluded', () => {
    const data=input({tasks:[task(),task({id:'today',end:'2026-09-14'}),task({id:'done',status:'done'}),task({id:'cancel',status:'cancelled'}),task({id:'summary',taskKind:'summary'}),task({id:'container',isContainer:true}),task({id:'unknown',end:null})]});
    expect(hits(data,'overdue').map(c=>c.objectId)).toEqual(['a']);
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'overdue',objectId:'unknown'});
    expect(evaluateRiskRules(data).rules).toHaveLength(6);
  });
  test('start due dependency alerts cite only unfinished predecessors, missing predecessor stays unknown', () => {
    const data=input({tasks:[task({id:'a',status:'done'}),task({id:'b'}),task({id:'c'}),task({id:'later',start:'2026-09-15'})],plan:plan({dependencies:[{predecessorId:'a',successorId:'b',type:'FS',lagDays:0},{predecessorId:'b',successorId:'c',type:'FS',lagDays:0},{predecessorId:'missing',successorId:'b',type:'FS',lagDays:0},{predecessorId:'b',successorId:'later',type:'FS',lagDays:0}]})});
    expect(hits(data,'dependency_blocked').map(c=>c.objectId)).toEqual(['c']);
    expect(hits(data,'dependency_blocked')[0]!.taskIds).toEqual(['c','b']);
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'dependency_blocked',objectId:'b'});
  });
  test('blocked duration is strictly more than two working days, using latest actual block in Shanghai', () => {
    const data=input({today:'2026-09-09',tasks:[task({blocked:true,events:[event('block','2026-09-03T16:05:00Z')]})]});
    expect(hits(data,'blocked_2_days')).toHaveLength(1); // Fri to Wed: Mon Tue Wed = 3
    data.today='2026-09-08'; expect(hits(data,'blocked_2_days')).toHaveLength(0);
    data.today='2026-09-14'; data.tasks[0]!.events.push(event('unblock','2026-09-10T00:00:00Z'),event('block','2026-09-13T16:05:00Z'));
    expect(hits(data,'blocked_2_days')).toHaveLength(0);
  });
  test('seed blocking has unknown age; unrelated updatedAt and calendar assumptions cannot prove duration', () => {
    const data=input({tasks:[task({blocked:true})]});
    expect(hits(data,'blocked_2_days')).toHaveLength(0);
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'blocked_2_days',objectId:'a'});
    data.tasks[0]!.events=[event('block','2026-09-01T00:00:00Z')]; data.plan.calendar.confirmed=false;
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'blocked_2_days',objectId:'a'});
  });
  test('milestone forecast propagates remaining duration instead of copying unchanged planned date', () => {
    const data=input({plan:milestonePlan(),tasks:[task({progress:60,status:'in_progress'})]});
    const hit=hits(data,'milestone_forecast_late')[0]!;
    expect(hit.objectId).toBe('m'); expect(hit.evidence).toContain('2026-09-15'); expect(hit.evidence).toContain('2026-09-11'); expect(hit.evidence).toContain('参考');
    data.tasks[0]!.progress=0; expect(hits(data,'milestone_forecast_late')[0]!.evidence).toContain('2026-09-18');
  });
  test('baseline is the promise even if current milestone moved; absent baseline entry falls back to current date', () => {
    const p=milestonePlan(); p.nodes[1]!.start=p.nodes[1]!.end='2026-09-21'; p.baselines=[baseline([{taskId:'m',owner:'成员',start:'2026-09-11',end:'2026-09-11',effortHours:0}])];
    expect(hits(input({plan:p}),'milestone_forecast_late')[0]!.evidence).toContain('承诺 2026-09-11');
    p.baselines[0]!.entries=[]; expect(hits(input({plan:p}),'milestone_forecast_late')).toHaveLength(0);
    p.baselines[0]!.entries=[{taskId:'m',owner:'成员',start:null,end:null,effortHours:0}];
    expect(evaluateRiskRules(input({plan:p})).unknown).toContainEqual({rule:'milestone_forecast_late',objectId:'m'});
  });
  test('forecast follows branched graph, business-day lag and remaining successor duration', () => {
    const p=milestonePlan(); p.nodes=[node({id:'a',durationDays:2}),node({id:'b',durationDays:1}),node({id:'c',durationDays:2}),p.nodes[1]!];
    p.dependencies=[{predecessorId:'a',successorId:'c',type:'FS',lagDays:1},{predecessorId:'b',successorId:'c',type:'FS',lagDays:0},{predecessorId:'c',successorId:'m',type:'FS',lagDays:0}];
    const hit=hits(input({plan:p,tasks:[task(),task({id:'b'}),task({id:'c'})]}),'milestone_forecast_late')[0]!;
    expect(hit.evidence).toContain('2026-09-18'); expect(hit.taskIds).toEqual(expect.arrayContaining(['a','b','c']));
  });
  test.each(['duration','dangling','cycle','calendar','completed_unknown','cancelled'] as const)('forecast %s input remains unknown instead of zero duration', mode => {
    const p=milestonePlan(); const tasks=[task()];
    if(mode==='duration') p.nodes[0]!.durationDays=null;
    if(mode==='dangling') p.dependencies[0]!.predecessorId='lost';
    if(mode==='cycle') p.dependencies.push({predecessorId:'m',successorId:'a',type:'FS',lagDays:0});
    if(mode==='calendar') p.calendar.confirmed=false;
    if(mode==='completed_unknown') tasks[0]!.status='done';
    if(mode==='cancelled') tasks[0]!.status='cancelled';
    const result=evaluateRiskRules(input({plan:p,tasks}));
    expect(result.candidates.filter(c=>c.rule==='milestone_forecast_late')).toEqual([]);
    expect(result.unknown).toContainEqual({rule:'milestone_forecast_late',objectId:'m'});
  });
  test('capacity requires explicit real input, checks strict 100% and preserves unknown and zero capacity', () => {
    for(const capacity of [undefined,[]]) expect(evaluateRiskRules(input({capacity})).rules.find(r=>r.key==='capacity_overload')!.status).toBe('unknown');
    const capacity=[{ownerId:'owner',owner:'成员',week:'2026-09-14',plannedHours:40,availableHours:40,taskIds:['a']}];
    expect(hits(input({capacity}),'capacity_overload')).toHaveLength(0);
    capacity[0]!.plannedHours=40.1; expect(hits(input({capacity}),'capacity_overload')).toHaveLength(1);
    capacity[0]!.availableHours=0; expect(hits(input({capacity}),'capacity_overload')[0]!.evidence).toContain('0');
    expect(evaluateRiskRules(input({capacity:[{...capacity[0]!,availableHours:null}]})).unknown).toContainEqual({rule:'capacity_overload',objectId:'owner:2026-09-14'});
  });
  test('commitment completeness uses baseline membership and exempts milestone effort, summaries and cancellations', () => {
    const tasks=[task({ownerId:'',owner:'',effortHours:null,end:null}),task({id:'new',ownerId:'',effortHours:null}),task({id:'summary',taskKind:'summary'}),task({id:'cancelled',status:'cancelled'})];
    const p=plan({nodes:[node(),node({id:'m',kind:'milestone',durationDays:0,effortHours:0})]});
    p.baselines=[baseline(['a','m','summary','cancelled'].map(taskId=>({taskId,start:'2026-09-07',end:'2026-09-11',owner:'成员',effortHours:taskId==='m'?0:40})))];
    p.calendar.confirmed=false;
    const result=hits(input({tasks,plan:p}),'commitment_incomplete');
    expect(result.map(c=>c.objectId)).toEqual(['a','p:calendar']);
    expect(result[0]!.evidence).toContain('负责人'); expect(result[0]!.evidence).toContain('日期'); expect(result[0]!.evidence).toContain('估算');
  });
  test('completed predecessors use actual finish and working-day exceptions, without applying old unfinished paths', () => {
    const p=milestonePlan(); p.calendar.exceptions['2026-09-14']=false;
    const data=input({plan:p,today:'2026-09-14',tasks:[task({status:'done',actualEnd:'2026-09-11'})]});
    expect(hits(data,'milestone_forecast_late')[0]!.evidence).toContain('2026-09-15');
    data.today='2026-09-11'; expect(hits(data,'milestone_forecast_late')).toEqual([]);
  });
  test('missing predecessor preserves unknown even when another predecessor proves blockage', () => {
    const p=plan({dependencies:[{predecessorId:'a',successorId:'b',type:'FS',lagDays:0},{predecessorId:'lost',successorId:'b',type:'FS',lagDays:0}]});
    const result=evaluateRiskRules(input({plan:p,tasks:[task(),task({id:'b'})]}));
    expect(result.candidates.filter(c=>c.rule==='dependency_blocked').map(c=>c.objectId)).toEqual(['b']);
    expect(result.unknown).toContainEqual({rule:'dependency_blocked',objectId:'b'});
    expect(result.rules.find(r=>r.key==='dependency_blocked')!.status).toBe('partial');
  });
  test('equal-timestamp block events use event order and an inconsistent latest unblock remains unknown', () => {
    const data=input({tasks:[task({blocked:true,events:[event('block','2026-09-01T00:00:00Z'),event('unblock','2026-09-01T00:00:00Z')]})]});
    expect(hits(data,'blocked_2_days')).toEqual([]);
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'blocked_2_days',objectId:'a'});
    data.tasks[0]!.events.reverse();
    expect(hits(data,'blocked_2_days')).toHaveLength(1);
  });
  test('capacity aggregates containing excluded tasks cannot be silently treated as executable load', () => {
    const data=input({tasks:[task({status:'cancelled'})],capacity:[{ownerId:'owner',owner:'成员',week:'2026-09-14',plannedHours:80,availableHours:40,taskIds:['a']}]});
    expect(hits(data,'capacity_overload')).toEqual([]);
    expect(evaluateRiskRules(data).unknown).toContainEqual({rule:'capacity_overload',objectId:'owner:2026-09-14'});
    data.tasks=[task()]; data.capacity![0]!.plannedHours=0; data.capacity![0]!.availableHours=0;
    expect(hits(data,'capacity_overload')).toEqual([]);
  });
  test('a bad path does not suppress an independently known late milestone', () => {
    const p=milestonePlan(); p.dependencies[0]!.predecessorId='lost';
    p.nodes.push(node({id:'independent',kind:'milestone',durationDays:0}));
    const result=evaluateRiskRules(input({plan:p}));
    expect(result.candidates.filter(c=>c.rule==='milestone_forecast_late').map(c=>c.objectId)).toEqual(['independent']);
    expect(result.unknown).toContainEqual({rule:'milestone_forecast_late',objectId:'m'});
    expect(result.rules.find(r=>r.key==='milestone_forecast_late')!.status).toBe('partial');
  });

  test('plan-only milestone blocks a task with evidence but does not masquerade as an executable task link', () => {
    const p=plan({nodes:[node({id:'m',kind:'milestone',durationDays:0})],dependencies:[{predecessorId:'m',successorId:'b',type:'FS',lagDays:0}]});
    p.nodes[0]!.title='验收里程碑';
    const alert=hits(input({plan:p,tasks:[task({id:'b'})]}),'dependency_blocked')[0]!;
    expect(alert.taskIds).toEqual(['b']); expect(alert.evidence).toContain('验收里程碑');
  });
  test('completed plan-only milestone has no actual finish evidence for a ten-workday successor lag', () => {
    const p=milestonePlan(); p.nodes.push(node({id:'completed',kind:'milestone',status:'done',durationDays:0,start:'2026-09-01',end:'2026-09-01'}));
    p.dependencies.push({predecessorId:'completed',successorId:'a',type:'FS',lagDays:10});
    const result=evaluateRiskRules(input({plan:p}));
    expect(result.candidates.filter(c=>c.rule==='milestone_forecast_late')).toEqual([]);
    expect(result.unknown).toContainEqual({rule:'milestone_forecast_late',objectId:'m'});
  });

});
