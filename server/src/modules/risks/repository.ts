import { projectRiskResponsibilities, readRiskResponsibilityCandidates } from './responsibilities.js';
import { isExistingDatabase } from '../../db/lifecycle.js';
import {readDeletedTaskSnapshots} from '../tasks/recycle-store.js';
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManagedRisk, RiskAlert, RiskEvent, RiskWorkspace, RuleEvaluation } from '../../../../shared/src/risks.js';
import { readTasks } from '../tasks/repository.js';
import { readPeople } from '../settings/store.js';
import { shanghaiDate } from '../analytics/dates.js';
import { PlanError } from '../planning/errors.js';

type JsonRow = { snapshot_json: string };
type StateRow = { revision: number; rules_json: string; last_evaluated_at: string | null; evaluation_error: string | null };
export function initializeRisks(db: Database.Database) {
  if (isExistingDatabase(db)) return;
  db.transaction(() => {
    db.exec(`CREATE TABLE IF NOT EXISTS risk_projects (project_id TEXT PRIMARY KEY REFERENCES homepage_projects(id), revision INTEGER NOT NULL, rules_json TEXT NOT NULL CHECK(json_valid(rules_json)), last_evaluated_at TEXT, evaluation_error TEXT);
      CREATE TABLE IF NOT EXISTS risk_records (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES risk_projects(project_id), snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)));
      CREATE INDEX IF NOT EXISTS risk_records_project ON risk_records(project_id);
      CREATE TABLE IF NOT EXISTS risk_alerts (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES risk_projects(project_id), rule_key TEXT NOT NULL, object_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), UNIQUE(project_id,rule_key,object_id));
      CREATE TABLE IF NOT EXISTS risk_alert_observations (alert_id TEXT PRIMARY KEY REFERENCES risk_alerts(id) ON DELETE CASCADE, observed_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS risk_idempotency (project_id TEXT NOT NULL REFERENCES risk_projects(project_id), request_key TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL CHECK(json_valid(response_json)), PRIMARY KEY(project_id,request_key));`);
    for (const project of db.prepare('SELECT id,snapshot_json FROM homepage_projects').all() as Array<{ id: string; snapshot_json: string }>) {
      if (db.prepare('SELECT project_id FROM risk_projects WHERE project_id=?').get(project.id)) continue;
      db.prepare("INSERT INTO risk_projects VALUES (?,1,'[]',NULL,NULL)").run(project.id);
      const snapshot = JSON.parse(project.snapshot_json); const workspace = readTasks(db, project.id, '');
      for (const old of snapshot.risks) {
        const risk: ManagedRisk = { ...old, workstreamId: workspace.tasks.find(t => old.taskIds.includes(t.id))?.workstreamId ?? workspace.workstreams[0]!.id, ownerId: workspace.actors.find(actor => actor.name === old.owner)?.id ?? '',
          probability: null, impact: null, score: null, legacyLevel: old.level, status: 'identified', occurred: false, reviewDate: null, response: '', acceptanceReason: '', actionTaskIds: [], sourceAlertId: null, closeReviewerId: null, closure: null,
          version: 1, createdAt: '2026-09-07T00:00:00.000Z', updatedAt: '2026-09-07T00:00:00.000Z', events: [{ id: `import-${old.id}`, action: 'import', actor: '本地 DEMO', text: '保留原示例风险与历史等级，概率和影响等待人工评估。', createdAt: '2026-09-07T00:00:00.000Z' }] };
        db.prepare('INSERT INTO risk_records VALUES (?,?,?)').run(risk.id, project.id, JSON.stringify(risk));
      }
    }
  })();
}
export function listRisks(db: Database.Database, projectId: string): ManagedRisk[] { return (db.prepare('SELECT snapshot_json FROM risk_records WHERE project_id=? ORDER BY rowid').all(projectId) as JsonRow[]).map(row => JSON.parse(row.snapshot_json)); }
export function listAlerts(db: Database.Database, projectId: string): RiskAlert[] {
  const deletedIds=new Set(readDeletedTaskSnapshots(db,projectId).map(t=>t.id));
  return (db.prepare('SELECT a.snapshot_json,o.observed_at FROM risk_alerts a LEFT JOIN risk_alert_observations o ON o.alert_id=a.id WHERE a.project_id=? ORDER BY a.rowid').all(projectId) as Array<JsonRow & {observed_at:string|null}>).map(row => {
    const alert=JSON.parse(row.snapshot_json) as RiskAlert;
    delete alert.sourceDeleted;
    if(deletedIds.has(alert.objectId)||alert.taskIds.some(id=>deletedIds.has(id)))alert.sourceDeleted=true;
    if (row.observed_at !== null) alert.lastTriggeredAt=row.observed_at;
    return alert;
  });
}
/** Stable observations update a narrow projection, leaving audit snapshots intact. */
export function observeAlerts(db:Database.Database,projectId:string,ids:string[],now:Date) {
  if (!ids.length) return;
  db.prepare('INSERT INTO risk_alert_observations(alert_id,observed_at) SELECT id,? FROM risk_alerts WHERE project_id=? AND id IN (SELECT value FROM json_each(?)) ON CONFLICT(alert_id) DO UPDATE SET observed_at=excluded.observed_at').run(now.toISOString(),projectId,JSON.stringify(ids));
}
export function riskState(db: Database.Database, projectId: string): StateRow {
  const state = db.prepare('SELECT * FROM risk_projects WHERE project_id=?').get(projectId) as StateRow | undefined;
  if (!state) throw new PlanError(404, 'PROJECT_NOT_FOUND', '未找到此项目。'); return state;
}
export function readRisks(db: Database.Database, projectId: string, token: string, now: Date): RiskWorkspace {
  const state = riskState(db, projectId); const workspace = readTasks(db, projectId, token, now);
  const responsibilityCandidates = readRiskResponsibilityCandidates(db, projectId);
  const risks = listRisks(db, projectId).map(risk => projectRiskResponsibilities(risk, responsibilityCandidates));
  return { mode: workspace.mode, project: workspace.project, today: shanghaiDate(now), version: state.revision, planVersion: workspace.planVersion, writeToken: token, actors: workspace.actors, workstreams: workspace.workstreams, tasks: workspace.tasks,
    responsibilityCandidates, people: readPeople(db, projectId, [...(workspace.people ?? []).map(person => person.id), ...risks.flatMap(risk => [risk.ownerId, risk.closeReviewerId, risk.closure?.submittedBy, risk.closure?.reviewedById])]),
    risks, alerts: listAlerts(db, projectId), rules: JSON.parse(state.rules_json) as RuleEvaluation[], lastEvaluatedAt: state.last_evaluated_at,
    warnings: [workspace.project.isDemo ? 'DEMO · 示例项目风险台账与规则，无外部通知。' : '项目风险台账与自动规则，仅提供站内通知。', ...(workspace.project.asOf !== shanghaiDate(now) ? ['自动规则采用 Asia/Shanghai 系统当前日；首页业务观察日为示例日期。'] : []), ...(state.evaluation_error ? [state.evaluation_error] : [])] };
}
export function saveRisk(db: Database.Database, projectId: string, risk: ManagedRisk) {
  const { needsHandover: _needsHandover, responsibilityIssues: _issues, ...snapshot } = risk;
  db.prepare('INSERT INTO risk_records VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(risk.id, projectId, JSON.stringify(snapshot));
}
export function saveAlert(db: Database.Database, projectId: string, alert: RiskAlert) {
  const save=()=>{
    db.prepare('INSERT INTO risk_alerts VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET snapshot_json=excluded.snapshot_json').run(alert.id, projectId, alert.rule, alert.objectId, JSON.stringify(alert));
    // A full state/evidence save incorporates the latest observed timestamp.
    db.prepare('DELETE FROM risk_alert_observations WHERE alert_id=?').run(alert.id);
  };
  if (db.inTransaction) save(); else db.transaction(save)();
}
export function bumpRevision(db: Database.Database, projectId: string) { db.prepare('UPDATE risk_projects SET revision=revision+1 WHERE project_id=?').run(projectId); return riskState(db, projectId).revision; }
export function appendEvent(target: { events: RiskEvent[]; version: number }, action: string, actor: string, text: string, now: Date) { target.events.push({ id: randomUUID(), action, actor, text, createdAt: now.toISOString() }); target.version++; }
