import type Database from 'better-sqlite3';
import { initializeMilestones, readMilestoneRecords, saveMilestoneRecord } from '../../server/src/modules/milestones/store.js';
/** Explicit test-only identities/criteria; production migration must never guess them. */
export function configureMilestoneBaselineFixture(db: Database.Database, now = new Date('2026-09-21T08:00:00.000Z')) {
  initializeMilestones(db, now);
  for (const record of readMilestoneRecords(db, 'phase-one')) saveMilestoneRecord(db, 'phase-one', { ...record, ownerId:'zhou',reviewerId:'lin',criteria:[{id:'report',kind:'evidence',title:'验收报告',taskId:null}] });
}
