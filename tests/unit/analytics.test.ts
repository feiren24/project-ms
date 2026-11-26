import { describe, expect, test } from 'vitest';
import type { AnalyticsFilters } from '../../shared/src/analytics.js';
import type { ManagedTask } from '../../shared/src/tasks.js';
import type { PlanBaseline, ProjectPlan } from '../../shared/src/planning.js';
import { taskMetrics, executable, selected } from '../../server/src/modules/analytics/metrics.js';
import { resourceCapacity } from '../../server/src/modules/analytics/capacity.js';
import { planDeviations } from '../../server/src/modules/analytics/deviations.js';
import { deliveryTrend } from '../../server/src/modules/analytics/trend.js';
import { isoWeek, shanghaiDate } from '../../server/src/modules/analytics/dates.js';
import { defaultCalendar } from '../../server/src/modules/planning/calendar.js';
import type { DailySnapshot } from '../../server/src/modules/analytics/snapshots.js';
const filters: AnalyticsFilters = {from:'2026-09-07',to:'2026-09-20',workstreamId:'',ownerId:'',baselineId:'b',capacityMode:'unknown'};
const task = (extra: Partial<ManagedTask> = {}) => ({id:'a',title:'执行任务',wbs:'1',workstreamId:'w',ownerId:'chen',owner:'陈知远',status:'todo',progress:0,start:'2026-09-07',end:'2026-09-18',effortHours:80,blocked:false,requiresReview:false,reviewStatus:'none',actualEnd:null,parentId:null,completionPlanEnd:null,...extra}) as ManagedTask & {completionPlanEnd:string|null};
const baseline = (entries: PlanBaseline['entries']): PlanBaseline => ({id:'b',name:'基线',createdAt:'2026-09-07T00:00:00Z',actor:'DEMO',reason:'test',entries,dependencies:[],calendar:structuredClone(defaultCalendar),excludedIds:[],demo:true});
const plan = { nodes:[],calendar:defaultCalendar } as unknown as ProjectPlan;
const entry = {taskId:'a',start:'2026-09-07',end:'2026-09-18',effortHours:80,owner:'陈知远'};
describe('analytics truthful metrics and allocation', () => {
  test('empty and zero denominators stay null; missing estimates never become zero', () => {
    expect(taskMetrics([]).completion).toMatchObject({value:null,denominator:0});
    const result = taskMetrics([task({effortHours:0,progress:100,status:'done'}),task({id:'b',effortHours:null}),task({id:'c',effortHours:20,progress:50})]);
    expect(result.weightedProgress).toMatchObject({value:0.5,numerator:10,denominator:20,missing:2});
    expect(result.estimationCoverage.value).toBeCloseTo(1/3); expect(result.onTime).toMatchObject({value:null,denominator:0,missing:1});
    expect(taskMetrics([task({effortHours:0})]).weightedProgress.value).toBeNull();
    const invalid = taskMetrics([task({effortHours:-1}), task({effortHours:Number.NaN}), task({effortHours:Number.POSITIVE_INFINITY})]);
    expect(invalid.estimationCoverage).toMatchObject({value:0,numerator:0,denominator:3,missing:3}); expect(invalid.weightedProgress).toMatchObject({value:null,denominator:0,missing:3});
  });
  test('on time uses baseline else frozen completion plan, never edited current end or unknown actual', () => {
    const completed = task({status:'done',progress:100,end:'2026-10-30',actualEnd:'2026-09-21',completionPlanEnd:'2026-09-18'});
    expect(taskMetrics([completed]).onTime).toMatchObject({value:0,numerator:0,denominator:1});
    expect(taskMetrics([completed],baseline([{...entry,end:'2026-09-22'}])).onTime.value).toBe(1);
    expect(taskMetrics([completed],baseline([{...entry,end:null}])).onTime).toMatchObject({value:null,missing:1});
    expect(taskMetrics([task({...completed,actualEnd:null})],baseline([entry])).onTime).toMatchObject({value:null,missing:1});
    expect(taskMetrics([task({...completed,completionPlanEnd:null})]).onTime.value).toBeNull();
  });
  test('persistent summaries stay excluded after cancelled children and unplanned tasks stay in windows', () => {
    expect(executable(task({taskKind:'summary',status:'todo'}))).toBe(false);
    expect(selected(task({start:null,end:null}),filters)).toBe(true);
    expect(selected(task({start:'2026-10-01',end:'2026-10-10'}),filters)).toBe(false);
  });
  test('full plan effort divides before cropping window; unknown capacities and unallocated reasons stay explicit', () => {
    const result = resourceCapacity([task(),task({id:'missing',start:null,effortHours:null,ownerId:''})],[{id:'chen',name:'陈知远'}],{...filters,from:'2026-09-14'},defaultCalendar);
    expect(result.members[0]!.cells[0]).toMatchObject({plannedHours:40,availableHours:null,ratio:null,status:'unknown'});
    expect(result.unallocated[0]!.reason).toContain('缺负责人、未排期、未估算');
    const calendar = resourceCapacity([task()],[{id:'chen',name:'陈知远'}],{...filters,from:'2026-09-14',capacityMode:'calendar'},defaultCalendar);
    expect(calendar.members[0]!.cells[0]).toMatchObject({plannedHours:40,availableHours:40,ratio:1,status:'normal'});
    const conflict = resourceCapacity([task()],[{id:'chen',name:'陈知远'}],{...filters,capacityMode:'calendar'},{...defaultCalendar,hoursPerDay:0});
    expect(conflict.members[0]!.cells[0]).toMatchObject({availableHours:0,ratio:null,status:'conflict'});
    const noDays = resourceCapacity([task()],[{id:'chen',name:'陈知远'}],filters,{...defaultCalendar,weekdays:[]});
    expect(noDays.unallocated[0]!.reason).toContain('无工作日');
  });
  test('week labels use ISO year, Monday starts, and Shanghai midnight differs from UTC', () => {
    expect(isoWeek('2027-01-01')).toBe('2026-W53'); expect(isoWeek('2027-01-04')).toBe('2027-W01'); expect(isoWeek('2026-09-13')).toBe('2026-W37');
    expect(shanghaiDate(new Date('2026-09-07T16:01:00Z'))).toBe('2026-09-08');
  });
  test('deviations use baseline calendar, real actual completion and union window while keeping cancelled/new/missing', () => {
    const tasks = [task({end:'2026-09-21'}),task({id:'done',status:'done',actualEnd:null}),task({id:'cancelled',status:'cancelled'}),task({id:'new'}),task({id:'summary',taskKind:'summary'}),task({id:'unplanned',start:null,end:null})];
    const base = baseline(['a','done','cancelled','lost','summary','milestone','unplanned'].map(taskId => ({...entry,taskId})));
    base.calendar.exceptions['2026-09-21'] = false;
    const result = planDeviations(tasks,{...plan,nodes:[{id:'milestone',kind:'milestone'}] as ProjectPlan['nodes']},filters,base);
    expect(result.find(d => d.taskId === 'a')).toMatchObject({deltaDays:0,state:'unchanged'});
    expect(result.find(d => d.taskId === 'done')).toMatchObject({deltaDays:null,state:'missing'});
    expect(result.find(d => d.taskId === 'cancelled')).toMatchObject({state:'cancelled',canOpen:true}); expect(result.find(d => d.taskId === 'new')?.state).toBe('new'); expect(result.find(d => d.taskId === 'lost')).toMatchObject({state:'missing',canOpen:false}); expect(result.find(d => d.taskId === 'unplanned')?.state).toBe('unplanned');
    expect(result.some(d => ['summary','milestone'].includes(d.taskId))).toBe(false);
    expect(planDeviations([task({start:'2026-10-01',end:'2026-10-10'})],plan,filters,baseline([entry]))).toHaveLength(1);
    expect(planDeviations(tasks,plan,{...filters,ownerId:'zhou'},base)).toHaveLength(0);
  });
  test('historical trend filters snapshot ownership and estimates with gaps; baseline reference never invents actual points', () => {
    const original = task({effortHours:20,progress:25});
    const snapshots: DailySnapshot[] = [{date:'2026-09-07',capturedAt:'2026-09-07T03:00:00Z',dataAsOf:'2026-09-21',planVersion:1,tasks:[original],milestones:[]}];
    const current = task({ownerId:'zhou',workstreamId:'other',effortHours:80,progress:100});
    const result = deliveryTrend(snapshots,[current],plan,{...filters,to:'2026-09-09',ownerId:'chen',workstreamId:'w'},baseline([entry]));
    expect(result.points[0]).toMatchObject({actual:.25,planned:null}); expect(result.points[1]).toMatchObject({actual:null,capturedAt:null});
    const reference = deliveryTrend(snapshots,[original],plan,{...filters,to:'2026-09-09'},baseline([entry]));
    expect(reference.points.map(p => p.planned)).toEqual([.1,.2,.3]);
    const historicalOwner = deliveryTrend([],[],plan,{...filters,ownerId:'zhou'},baseline([{...entry,taskId:'lost',owner:'周亦安'}]),[{id:'zhou',name:'周亦安'}]);
    expect(historicalOwner.points[0]!.planned).toBe(.1);
    expect(deliveryTrend([],[],plan,filters,baseline([{...entry,effortHours:0}])).points[0]!.planned).toBeNull(); expect(reference.points[0]!.actual).toBe(.25);
  });
});
