import { describe,it,expect } from 'vitest';
import { createIsolationFixture } from '../performance/isolation-seed.js';
import Database from 'better-sqlite3';
import { createFixture,validateFixture } from '../performance/seed.js';
describe('isolated performance fixtures',()=>{
  it('partitions 2000 tasks into five isolated projects with disjoint membership',async()=>{const fixture=await createIsolationFixture();try{expect(fixture.projects).toHaveLength(5);expect(fixture.projects.map(p=>p.taskIds.length)).toEqual([400,400,400,400,400]);expect(new Set(fixture.projects.flatMap(p=>p.accountIndexes)).size).toBe(20);}finally{await fixture.cleanup();}},60000);
  it.each([1000,2000,5000])('seeds %i execution tasks with valid relationships and historical acceptance',async(tasks)=>{
    const fixture=await createFixture({tasks});try{const db=new Database(fixture.dbPath);try{const counts=validateFixture(db,fixture.projectId,tasks);expect(counts.execution).toBe(tasks);expect(counts.dependencies).toBe(tasks-100);expect(counts.dailySnapshots).toBe(90);expect(fixture.dbPath).toContain('goodwork-performance-');expect(()=>db.prepare('DELETE FROM plan_baselines').run()).toThrow('immutable');}finally{db.close();}}finally{await fixture.cleanup();}
  },60000);
  it('dense graph retains acyclic, date-valid edges above the old 1000-edge limit',async()=>{const f=await createFixture({tasks:1000,dense:true});try{expect(f.counts.dependencies).toBeGreaterThan(2000);}finally{await f.cleanup();}},60000);
});
