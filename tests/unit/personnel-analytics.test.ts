import { describe, expect, test } from 'vitest';
import type { AnalyticsTask } from '../../shared/src/analytics';
import type { ProjectMember } from '../../shared/src/settings';
import type { PlanBaseline } from '../../shared/src/planning';
import { personnelAnalysis } from '../../server/src/modules/analytics/personnel';
import { sortedPersonnel, personnelSelectionIds } from '../../client/src/features/analytics/personnel';
import { taskMetrics } from '../../server/src/modules/analytics/metrics';

const member = (id: string, extra: Partial<ProjectMember> = {}): ProjectMember => ({ id, name: id, active: true, role: 'member', ...extra });
const task = (id: string, extra: Partial<AnalyticsTask> = {}): AnalyticsTask => ({ id, wbs: id, title: id, workstreamId: 'w', ownerId: 'a', owner: 'a', status: 'todo', progress: 0, start: '2026-09-01', end: '2026-09-09', effortHours: 8, blocked: false, requiresReview: false, reviewStatus: 'none', actualEnd: null, parentId: null, completionPlanEnd: null, ...extra });
const done = (id: string, actualEnd: string | null): AnalyticsTask => task(id, { status: 'done', progress: 100, actualEnd, completionPlanEnd: '2026-09-09' });
const baseline = (entries: PlanBaseline['entries']): PlanBaseline => ({ id:'b', name:'b', createdAt:'2026-09-01', actor:'a', reason:'test', entries, dependencies:[], calendar:{ weekdays:[1,2,3,4,5], hoursPerDay:8, confirmed:true, exceptions:{} }, excludedIds:[], demo:true });

describe('personnel task facts', () => {
  test('ten-task worked example uses different denominators and drilldowns reconcile', () => {
    const tasks = [done('1','2026-09-08'),done('2','2026-09-09'),done('3','2026-09-09'),done('4','2026-09-10'),done('5','2026-09-11'),done('6',null),task('7'),task('8',{blocked:true,reviewStatus:'submitted'}),task('9',{end:'2026-09-10'}),task('10',{end:null})];
    const result = personnelAnalysis(tasks,[member('a')],'2026-09-10');
    expect(result.summary.metrics.completion).toMatchObject({value:.6,numerator:6,denominator:10});
    expect(result.summary.metrics.overdue).toMatchObject({value:2/3,numerator:2,denominator:3,missing:1,numeratorTaskIds:['7','8']});
    expect(result.summary.metrics.late).toMatchObject({value:.4,numerator:2,denominator:5,missing:1,numeratorTaskIds:['4','5']});
    expect(result.summary.metrics.onTime.value).toBe(.6);
    expect(result.summary.counts).toMatchObject({total:10,done:6,todo:4,blocked:1,review:1,unplanned:1,missingActual:1});
    for (const metric of Object.values(result.summary.metrics)) {
      expect(metric.numeratorTaskIds).toHaveLength(metric.numerator);
      expect(metric.denominatorTaskIds).toHaveLength(metric.denominator);
      expect(metric.missingTaskIds).toHaveLength(metric.missing);
    }
    expect(result.tasks.find(t=>t.taskId==='9')?.state).toBe('not_overdue');
  });
  test('empty data stays unknown and total rates are not member averages', () => {
    const empty=personnelAnalysis([], [member('a')], '2026-09-10');
    expect(empty.members).toHaveLength(1);
    expect(Object.values(empty.summary.metrics).every(m=>m.value===null)).toBe(true);
    const tasks=[done('a','2026-09-09'),...Array.from({length:9},(_,i)=>task(`b${i}`,{ownerId:'b'}))];
    expect(personnelAnalysis(tasks,[member('a'),member('b')],'2026-09-10').summary.metrics.completion.value).toBe(.1);
  });
  test('baseline matches existing on-time logic including missing baseline end and frozen fallback', () => {
    const tasks=[done('a','2026-09-09'),done('b','2026-09-09'),done('c','2026-09-09')];
    const b=baseline([{taskId:'a',start:null,end:'2026-09-08',effortHours:null,owner:'a'},{taskId:'b',start:null,end:null,effortHours:null,owner:'a'}]);
    const r=personnelAnalysis(tasks,[member('a')],'2026-09-10',b);
    expect(r.summary.metrics.onTime.value).toBe(taskMetrics(tasks,b).onTime.value);
    expect(r.summary.metrics.late).toMatchObject({numerator:1,denominator:2,missing:1});
    expect(r.tasks.map(t=>[t.state,t.referenceSource,t.referenceEnd])).toEqual([['late','baseline','2026-09-08'],['unknown_completed','baseline',null],['on_time','completion_plan','2026-09-09']]);
    const unfinished=task('a');
    expect(personnelAnalysis([unfinished],[member('a')],'2026-09-09',b).summary.metrics.overdue.numerator).toBe(0);
    tasks[2]!.end='2026-10-01';
    expect(personnelAnalysis(tasks,[member('a')],'2026-09-10',b).tasks[2]?.referenceEnd).toBe('2026-09-09');
  });
  test('groups by current ID, retains inactive history, and shows unassigned without losing tasks', () => {
    const tasks=[task('1',{ownerId:'old'}),task('2',{ownerId:'b'}),task('3',{ownerId:''}),task('4',{ownerId:'missing',owner:'历史人员'})];
    const members=[member('a',{name:'同名'}),member('b',{name:'同名'}),member('old',{removedAt:'2026-09-01'}),member('inactive',{active:false})];
    const r=personnelAnalysis(tasks,members,'2026-09-10');
    expect(r.members.map(m=>m.id)).toEqual(['a','b','old','missing',null]);
    expect(r.members.find(m=>m.id==='old')?.availability).toBe('removed');
    expect(r.members.reduce((n,m)=>n+m.counts.total,0)).toBe(r.summary.counts.total);
    expect(personnelAnalysis(tasks.filter(t=>t.ownerId==='b'),members,'2026-09-10',undefined,'b').members.map(m=>m.id)).toEqual(['b']);
  });
});

test('sort is stable, null stays last in both directions and refresh selections resolve current facts', () => {
  const r=personnelAnalysis([done('1','2026-09-09'),task('2',{ownerId:'b'}),task('3',{ownerId:'d'})],[member('a'),member('b'),member('c'),member('d')],'2026-09-10');
  expect(sortedPersonnel(r.members,{sortBy:'completion',direction:'desc',expanded:[]}).map(m=>m.id)).toEqual(['a','b','d','c']);
  expect(sortedPersonnel(r.members,{sortBy:'completion',direction:'asc',expanded:[]}).map(m=>m.id)).toEqual(['b','d','a','c']);
  expect(personnelSelectionIds(r,{memberId:'a',metric:'completion',part:'numerator'})).toEqual(['1']);
  expect(personnelSelectionIds(r,{memberId:'missing'})).toEqual([]);
  expect(personnelSelectionIds(r,{memberId:'c',metric:'late',part:'missing'})).toEqual([]);
  const refreshed=personnelAnalysis([task('1')],[member('a')],'2026-09-10');
  expect(personnelSelectionIds(refreshed,{memberId:'a',metric:'completion',part:'numerator'})).toEqual([]);
});
