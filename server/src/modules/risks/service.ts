import { projectRiskResponsibilities, requireRiskResponsibilities } from './responsibilities.js';
import { captureRiskActivity } from '../activities/hooks.js';
import {readDeletedTaskSnapshots} from '../tasks/recycle-store.js';
import { readOperationReason } from '../../operation-reasons.js';
import { riskOperationSummary } from '../../../../shared/src/operation-reasons.js';
import { isProjectManager } from '../../../../shared/src/permissions.js';
import { captureProjectEvents } from '../notifications/events.js';
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ManagedRisk, RiskAlert, RiskEvaluation, RiskWorkspace, RiskWriteResult } from '../../../../shared/src/risks.js';
import type { TaskActor } from '../../../../shared/src/tasks.js';
import { writeTask } from '../tasks/repository.js';
import { readActors } from '../settings/store.js';
import { readPlan } from '../planning/repository.js';
import { PlanError, requireValue } from '../planning/errors.js';
import { shanghaiDate } from '../analytics/dates.js';
import { overlaps } from '../analytics/dates.js';
import { resourceCapacity } from '../analytics/capacity.js';
import { analyticsTask, executable } from '../analytics/metrics.js';
import { calendarDay } from '../planning/calendar.js';
import { readCapacities, readMembers } from '../settings/store.js';
import { evaluateRiskRules, scoreRisk } from './rules.js';
import { appendEvent, bumpRevision, listAlerts, observeAlerts, readRisks, riskState, saveAlert, saveRisk } from './repository.js';
import { canMaintain, checkVersion, draftKeys, executionTask, futureDate, mutable, strict, textValue, validateDraft, writer } from './schema.js';

/** Unknown input preserves prior alerts; stable evidence never produces duplicate events. */
export function applyRiskEvaluation(db: Database.Database, projectId: string, evaluation: RiskEvaluation, now: Date) {
  return db.transaction(() => {
    const state = riskState(db, projectId); const alerts = listAlerts(db, projectId); const today = shanghaiDate(now); const hit = new Set<string>(); let changed = false;
    const alertsByKey = new Map<string,RiskAlert>();
    for (const alert of alerts) { const key=JSON.stringify([alert.rule,alert.objectId]); if (!alertsByKey.has(key)) alertsByKey.set(key,alert); }
    const unknownRules=new Set(evaluation.unknown.filter(item=>item.objectId===null).map(item=>item.rule));
    const unknownObjects=new Set(evaluation.unknown.filter(item=>item.objectId!==null).map(item=>JSON.stringify([item.rule,item.objectId])));
    const observedIds:string[]=[];
    const deletedIds=new Set(readDeletedTaskSnapshots(db,projectId).map(t=>t.id));
    for (const candidate of evaluation.candidates) {
      const identity = `${candidate.rule}:${candidate.objectId}`; if (hit.has(identity)) continue; hit.add(identity);
      let alert = alertsByKey.get(JSON.stringify([candidate.rule,candidate.objectId]));
      if (!alert) {
        alert = { ...candidate, id: `alert-${randomUUID()}`, ruleVersion: '1', status: 'open', firstTriggeredAt: now.toISOString(), lastTriggeredAt: now.toISOString(), snoozedUntil: null, snoozeReason: '', linkedRiskId: null, version: 0, events: [] };
        appendEvent(alert, 'trigger', '自动规则', candidate.evidence, now); saveAlert(db, projectId, alert); changed = true; continue;
      }
      const reopen = alert.status === 'resolved' || (alert.status === 'snoozed' && Boolean(alert.snoozedUntil && alert.snoozedUntil <= today));
      const evidenceChanged = ['title', 'evidence', 'workstreamId'].some(key => candidate[key as 'title'] !== alert![key as 'title']) || JSON.stringify([...candidate.taskIds].sort()) !== JSON.stringify([...alert.taskIds].sort());
      if (reopen || evidenceChanged) {
        Object.assign(alert, candidate); if (reopen) { alert.status = 'open'; alert.snoozedUntil = null; }
        alert.lastTriggeredAt = now.toISOString(); appendEvent(alert, reopen ? 'reopen' : 'evidence_changed', '自动规则', candidate.evidence, now); saveAlert(db, projectId, alert); changed = true;
      } else if (alert.lastTriggeredAt !== now.toISOString()) {
        // Refresh the most recent observed hit without inventing a new evidence event or write conflict.
        observedIds.push(alert.id);
      }
    }
    observeAlerts(db,projectId,observedIds,now);
    for (const alert of alerts) {
      if(deletedIds.has(alert.objectId)||alert.taskIds.some(id=>deletedIds.has(id)))continue;
      if (hit.has(`${alert.rule}:${alert.objectId}`) || alert.status === 'resolved') continue;
      if (unknownRules.has(alert.rule) || unknownObjects.has(JSON.stringify([alert.rule,alert.objectId]))) continue;
      // Only an explicitly evaluated rule can resolve an earlier result.
      const rule = evaluation.rules.find(rule => rule.key === alert.rule); if (!rule || rule.status === 'unknown') continue;
      alert.status = 'resolved'; alert.snoozedUntil = null; appendEvent(alert, 'resolved', '自动规则', '当前规则已不再命中；关联风险仍需人工复核关闭。', now); saveAlert(db, projectId, alert); changed = true;
    }
    const rules = JSON.stringify(evaluation.rules); changed ||= rules !== state.rules_json || state.evaluation_error !== null;
    db.prepare('UPDATE risk_projects SET rules_json=?,last_evaluated_at=?,evaluation_error=NULL WHERE project_id=?').run(rules, now.toISOString(), projectId);
    if (changed) bumpRevision(db, projectId);
    if (changed) captureProjectEvents(db, projectId, now);
  })();
}
export function evaluateProjectRisks(db: Database.Database, projectId: string, now: Date) {
  const workspace = readRisks(db, projectId, '', now);
  const plan = readPlan(db, projectId, '', now);
  // Keep the project window for both numerator and denominator: cutting at today
  // would turn the current week's ordinary allocation into a false overload.
  const tasks = workspace.tasks.filter(task => executable(task) && task.status !== 'done' && task.status !== 'cancelled'
    && overlaps(task.start, task.end, plan.project.start, plan.project.end)).map(analyticsTask);
  const allocation = resourceCapacity(tasks, readMembers(db, projectId), {
    from: plan.project.start, to: plan.project.end, ownerId: '', workstreamId: '', baselineId: '', capacityMode: 'configured',
  }, plan.calendar, readCapacities(db, projectId));
  const unallocatedIds=new Set(allocation.unallocated.map(item=>item.taskId));
  const unallocated = tasks.filter(task => unallocatedIds.has(task.id));
  const capacity = allocation.members.flatMap(member => member.cells.map(cell => ({
    ownerId: member.id, owner: member.name, week: cell.week, plannedHours: cell.plannedHours,
    // Missing assignments/estimates cannot silently resolve an earlier warning.
    availableHours: unallocated.some(task => (!task.ownerId || task.ownerId === member.id)
      && overlaps(task.start, task.end, cell.week, calendarDay(cell.week, 6))) ? null : cell.availableHours,
    taskIds: cell.tasks.map(task => task.taskId),
  })));
  const evaluation = evaluateRiskRules({ tasks: workspace.tasks, plan, today: workspace.today, capacity });
  const capacityRule = evaluation.rules.find(rule => rule.key === 'capacity_overload');
  const missing: string[] = [];
  if (!plan.calendar.confirmed) missing.push('项目工作日历尚未确认');
  else {
    // Use actual weekly availability, not null base alone: date overrides may
    // completely configure this project window without a daily default.
    const members = allocation.members.filter(member => member.cells.some(cell => cell.availableHours === null));
    if (members.length) missing.push(`${members.length} 名成员在计划窗口内的个人容量未配置完整`);
  }
  if (allocation.unallocated.length) missing.push(`${allocation.unallocated.length} 项任务未分配完整（${[...new Set(allocation.unallocated.map(task => task.reason))].join('；')}）`);
  if (capacityRule && missing.length) capacityRule.message += ` 容量依据：${missing.join('；')}。请到“成员与设置”核对工作日历与个人容量${allocation.unallocated.length ? '，并在任务管理补全未分配项' : ''}。`;
  applyRiskEvaluation(db, projectId, evaluation, now);
}
export function recordEvaluationFailure(db: Database.Database, projectId: string) {
  db.prepare('UPDATE risk_projects SET evaluation_error=? WHERE project_id=?').run('自动预警巡检失败，已成功的业务操作仍保留。请手动刷新重试；当前显示上次结果。', projectId);
}
function independentReviewer(risk: ManagedRisk, actors: TaskActor[]) {
  const reviewer = risk.closeReviewerId !== null ? actors.find(actor => actor.id === risk.closeReviewerId) : (actors.find(actor => actor.id !== risk.ownerId) ?? actors[0]);
  requireValue(reviewer, 'INDEPENDENT_REVIEWER_REQUIRED', '请先移交给有效项目负责人或项目管理员，再提交关闭复核。'); return reviewer;
}
function transitionRisk(risk: ManagedRisk, body: Record<string, unknown>, actor: TaskActor, workspace: RiskWorkspace, now: Date) {
  const action = String(body.action); const reason = readOperationReason(body.reason, { domain: 'risk', action, selfReview: actor.id === risk.ownerId || actor.id === risk.closure?.submittedBy }, 3000);
  requireValue(['assess', 'mitigate', 'monitor', 'accept', 'occur', 'submit_close', 'approve_close', 'reject_close', 'reopen'].includes(action), 'INVALID_ACTION', '不支持此风险状态操作。');
  if (action === 'approve_close' || action === 'reject_close') {
    requireValue(risk.status === 'pending_close' && risk.closure, 'INVALID_TRANSITION', '此风险尚未提交关闭复核。');
    const reviewer = isProjectManager(actor.role) ? actor : independentReviewer(risk, workspace.responsibilityCandidates);
    if (!isProjectManager(actor.role) && (actor.id !== reviewer.id || actor.id === risk.ownerId || actor.id === risk.closure.submittedBy)) throw new PlanError(403, 'SELF_REVIEW_FORBIDDEN', '仅指定复核人、项目负责人或管理员可处理；普通成员不能复核本人负责或提交的风险。');
    if (action === 'approve_close') {
      requireRiskResponsibilities(risk, workspace.responsibilityCandidates);
      for (const id of risk.actionTaskIds) {
        const task = workspace.tasks.find(task => task.id === id);
        if (!task || task.version !== risk.closure.taskVersions[id] || task.taskKind === 'summary') throw new PlanError(409, 'ACTION_TASK_CHANGED', '应对任务在提交后已变化，请驳回并核对最新任务，再重新提交。');
        requireValue(task.status === 'done' || Boolean(risk.closure.residualReasons[id]?.trim()), 'ACTION_TASK_INCOMPLETE', '应对任务尚未完成，须逐项说明接受剩余风险的原因。');
      }
      risk.status = 'closed';
    } else risk.status = 'monitoring';
    risk.closure.reviewedById = actor.id; risk.closure.reviewedAt = now.toISOString(); risk.closure.selfReview = actor.id === risk.ownerId || actor.id === risk.closure.submittedBy;
    appendEvent(risk, action, actor.name, `${reason || riskOperationSummary(action)}；实际复核人：${actor.name}${risk.closure.selfReview ? '；管理者自审' : ''}`, now); return;
  }
  canMaintain(actor, risk);
  if (action === 'reopen') {
    requireValue(risk.status === 'closed', 'INVALID_TRANSITION', '只有已关闭风险可以重开。');
    requireRiskResponsibilities(risk, workspace.responsibilityCandidates);
    independentReviewer(risk, workspace.responsibilityCandidates); risk.status = 'monitoring';
  } else {
    mutable(risk);
    if (action !== 'occur') requireValue(risk.probability !== null && risk.impact !== null, 'ASSESSMENT_REQUIRED', '请先填写人工概率与影响，历史示例等级不能替代评估。');
    if (action === 'assess') { requireValue(risk.status === 'identified', 'INVALID_TRANSITION', '只有已识别风险可以提交评估。'); risk.status = 'assessed'; }
    if (action === 'mitigate') { requireValue(risk.status === 'assessed', 'INVALID_TRANSITION', '请先完成风险评估。'); requireValue(risk.response.trim().length > 0, 'RESPONSE_REQUIRED', '请填写应对措施再启动应对。'); risk.status = 'mitigating'; }
    if (action === 'monitor') { requireValue(risk.status === 'mitigating', 'INVALID_TRANSITION', '只有应对中的风险可以进入监控。'); risk.status = 'monitoring'; }
    if (action === 'accept') { requireValue(['assessed', 'mitigating', 'monitoring'].includes(risk.status), 'INVALID_TRANSITION', '请先完成评估再接受风险。'); risk.reviewDate = futureDate(body.reviewDate, workspace.today); risk.acceptanceReason = reason; risk.status = 'monitoring'; }
    if (action === 'occur') { requireValue(!risk.occurred, 'INVALID_TRANSITION', '此风险已标记发生。'); risk.occurred = true; }
    if (action === 'submit_close') {
      requireRiskResponsibilities(risk, workspace.responsibilityCandidates);
      if (!isProjectManager(actor.role) && actor.id !== risk.ownerId) throw new PlanError(403, 'RISK_OWNER_REQUIRED', '仅风险责任人、项目负责人或管理员可以提交关闭。');
      requireValue(['mitigating', 'monitoring'].includes(risk.status), 'INVALID_TRANSITION', '请先完成应对或进入监控，再提交关闭。');
      const reviewer = independentReviewer(risk, workspace.responsibilityCandidates); risk.closeReviewerId = reviewer.id;
      const residual = body.residualReasons ?? {}; strict(residual, risk.actionTaskIds);
      const residualReasons: Record<string, string> = {}; const taskVersions: Record<string, number> = {};
      for (const [id, value] of Object.entries(residual)) residualReasons[id] = textValue(value, '剩余风险接受原因', 1500, true);
      for (const id of risk.actionTaskIds) {
        const task = workspace.tasks.find(task => task.id === id && task.taskKind !== 'summary');
        requireValue(task, 'INVALID_ACTION_TASK', '关联应对任务已不存在或变为汇总，请先处理关联。'); taskVersions[id] = task.version;
        requireValue(task.status === 'done' || Boolean(residualReasons[id]), 'ACTION_TASK_INCOMPLETE', '应对任务未全部完成，请逐项填写接受剩余风险的原因。');
      }
      risk.closure = { reason, residualReasons, taskVersions, submittedBy: actor.id }; risk.status = 'pending_close';
      appendEvent(risk, action, actor.name, `${reason}；复核人：${reviewer.name}；任务版本与剩余风险快照：${JSON.stringify({ taskVersions, residualReasons })}`, now); return;
    }
  }
  appendEvent(risk, action, actor.name, reason || riskOperationSummary(action), now);
}
export type RiskOperation = 'responsibilities' | 'create' | 'update' | 'transition' | 'action' | 'create_action' | 'snooze' | 'evaluate';
export function writeRisk(db: Database.Database, projectId: string, operation: RiskOperation, objectId: string | undefined, body: unknown, actorId: unknown, key: unknown, now: Date, actorDisplayName?: string): RiskWriteResult | RiskWorkspace {
  const actors = readActors(db, projectId);
  const storedActor = writer(actorId, key, actors);
  const actor = actorDisplayName ? { ...storedActor, name: actorDisplayName } : storedActor;
  strict(body, operation === 'responsibilities' ? ['expectedVersion', 'ownerId', 'closeReviewerId', 'reason'] : operation === 'create' ? [...draftKeys, 'sourceAlertId'] : operation === 'update' ? [...draftKeys, 'expectedVersion', 'reason'] : operation === 'transition' ? ['expectedVersion', 'action', 'reason', 'reviewDate', 'residualReasons'] : operation === 'action' ? ['expectedVersion', 'taskId', 'reason', 'remove'] : operation === 'create_action' ? ['expectedVersion', 'expectedPlanVersion', 'draft'] : operation === 'snooze' ? ['expectedVersion', 'reason', 'until'] : []);
  const hash = createHash('sha256').update(JSON.stringify({ operation, objectId, actorId, body })).digest('hex');
  return db.transaction(() => {
    const receipt = db.prepare('SELECT request_hash,response_json FROM risk_idempotency WHERE project_id=? AND request_key=?').get(projectId, key) as { request_hash: string; response_json: string } | undefined;
    if (receipt) { if (receipt.request_hash !== hash) throw new PlanError(409, 'IDEMPOTENCY_CONFLICT', '此操作标识已用于不同请求，请核对后使用新的操作标识。'); return JSON.parse(receipt.response_json); }
    const workspace = readRisks(db, projectId, '', now); let risk: ManagedRisk | undefined; let alert: RiskAlert | undefined; let result: RiskWriteResult | RiskWorkspace;
    const activityBefore = structuredClone(workspace.risks.find(item => item.id === objectId));
    let task: RiskWriteResult['task']; let planVersion = workspace.planVersion;
    if (operation === 'evaluate') {
      evaluateProjectRisks(db, projectId, now); result = readRisks(db, projectId, '', now);
    } else {
      if (operation === 'create') {
        const draft = validateDraft(body, workspace);
        if (!isProjectManager(actor.role) && actor.id !== draft.ownerId) throw new PlanError(403, 'RISK_FORBIDDEN', '普通成员只能登记自己负责的风险，项目负责人或管理员可为其他成员登记。');
        if ('sourceAlertId' in body && body.sourceAlertId !== null) {
          alert = workspace.alerts.find(alert => alert.id === body.sourceAlertId); requireValue(alert, 'INVALID_SOURCE_ALERT', '来源预警必须属于当前项目。');
          if (alert.linkedRiskId) throw new PlanError(409, 'ALERT_ALREADY_LINKED', '该预警已转为风险，请查看已有风险记录。', { riskId: alert.linkedRiskId });
        }
        risk = { ...draft, ...scoreRisk(draft.probability, draft.impact), id: `risk-${randomUUID()}`, owner: actors.find(a => a.id === draft.ownerId)!.name, legacyLevel: null, status: 'identified', occurred: false, acceptanceReason: '', actionTaskIds: [], sourceAlertId: alert?.id ?? null, closure: null, version: 0, createdAt: now.toISOString(), updatedAt: now.toISOString(), events: [] };
        appendEvent(risk, 'create', actor.name, '登记本机风险，人工评估与自动预警独立。', now);
        if (alert) { alert.linkedRiskId = risk.id; appendEvent(alert, 'convert', actor.name, `转为风险：${risk.title}（${risk.id}）`, now); saveAlert(db, projectId, alert); }
      } else if (operation === 'snooze') {
        alert = workspace.alerts.find(alert => alert.id === objectId); if (!alert) throw new PlanError(404, 'ALERT_NOT_FOUND', '未找到此项目中的预警。'); checkVersion(alert.version, body.expectedVersion);
        requireValue(alert.status !== 'resolved', 'ALERT_RESOLVED', '已经恢复的预警无需暂缓。'); alert.snoozeReason = readOperationReason(body.reason, { domain: 'risk', action: 'snooze' }, 1500); alert.snoozedUntil = futureDate(body.until, workspace.today); alert.status = 'snoozed';
        appendEvent(alert, 'snooze', actor.name, `${alert.snoozeReason}；暂缓至 ${alert.snoozedUntil}`, now); saveAlert(db, projectId, alert);
      } else {
        risk = workspace.risks.find(risk => risk.id === objectId); if (!risk) throw new PlanError(404, 'RISK_NOT_FOUND', '未找到此项目中的风险。'); checkVersion(risk.version, body.expectedVersion);
        if (operation === 'responsibilities') {
          canMaintain(actor, risk);
          const reason = textValue(body.reason, '责任移交原因', 1500, true);
          const owner = workspace.responsibilityCandidates.find(member => member.id === body.ownerId);
          const reviewer = workspace.responsibilityCandidates.find(member => member.id === body.closeReviewerId);
          requireValue(owner, 'INVALID_OWNER', '接手责任人须为本项目已启用且可分派的项目负责人或项目管理员。');
          requireValue(reviewer, 'INVALID_CLOSE_REVIEWER', '接手复核人须为本项目已启用且可分派的项目负责人或项目管理员。');
          const describe = (id: string | null) => id === null ? '默认管理复核' : `${workspace.people?.find(person => person.id === id)?.name ?? id}（${id}）`;
          const change = `责任人 ${describe(risk.ownerId)} → ${owner.name}（${owner.id}）；关闭复核人 ${describe(risk.closeReviewerId)} → ${reviewer.name}（${reviewer.id}）`;
          risk.ownerId = owner.id; risk.owner = owner.name; risk.closeReviewerId = reviewer.id;
          appendEvent(risk, 'responsibilities', actor.name, `${reason}；${change}`, now);
        } else if (operation === 'transition') transitionRisk(risk, body, actor, workspace, now);
        else {
          canMaintain(actor, risk); mutable(risk);
          if (operation === 'update') {
            requireValue(body.ownerId === risk.ownerId && body.closeReviewerId === risk.closeReviewerId, 'RISK_HANDOVER_REQUIRED', '变更风险责任人或复核人请使用责任移交，并填写移交原因。');
            const reason = readOperationReason(body.reason, { domain: 'risk', action: 'update' }, 1500); const draft = validateDraft(body, workspace, risk);
            if (!isProjectManager(actor.role) && draft.ownerId !== risk.ownerId) throw new PlanError(403, 'RISK_FORBIDDEN', '变更责任人需要项目负责人或管理员权限。');
            Object.assign(risk, draft, scoreRisk(draft.probability, draft.impact), { owner: actors.find(a => a.id === draft.ownerId)!.name });
            if (draft.probability !== null) risk.legacyLevel = null; else risk.level = risk.legacyLevel;
            appendEvent(risk, 'update', actor.name, reason || riskOperationSummary('update'), now);
          } else if (operation === 'action') {
            const reason = readOperationReason(body.reason, { domain: 'risk', action: 'link' }, 1500); requireValue(body.remove === undefined || typeof body.remove === 'boolean', 'INVALID_REMOVE', '移除标志必须是布尔值。');
            if (body.remove) { requireValue(typeof body.taskId === 'string' && risk.actionTaskIds.includes(body.taskId), 'ACTION_NOT_LINKED', '此任务尚未关联为应对措施。'); risk.actionTaskIds = risk.actionTaskIds.filter(id => id !== body.taskId); }
            else { const linked = executionTask(body.taskId, workspace); requireValue(!risk.actionTaskIds.includes(linked.id), 'ACTION_ALREADY_LINKED', '此任务已关联，无需重复添加。'); risk.actionTaskIds.push(linked.id); }
            appendEvent(risk, body.remove ? 'remove_action' : 'link_action', actor.name, `${reason || riskOperationSummary(body.remove ? 'remove' : 'link')}；任务 ${String(body.taskId)}`, now);
          } else {
            if (!isProjectManager(actor.role)) throw new PlanError(403, 'RISK_FORBIDDEN', '创建并关联应对任务需要项目负责人或管理员权限。');
            strict(body.draft, ['title', 'description', 'workstreamId', 'parentId', 'ownerId', 'priority', 'effortHours', 'requiresReview', 'reviewerId', 'acceptanceCriteria', 'evidence', 'start', 'end']);
            // A nested better-sqlite3 transaction is a SAVEPOINT: outer failure rolls back both writes and receipts.
            const created = writeTask(db, projectId, 'create', undefined, { ...body.draft, expectedPlanVersion: body.expectedPlanVersion }, actor.id, `risk-action:${createHash('sha256').update(String(key)).digest('hex')}`, now, actor.name);
            const createdTask = created.task as RiskWriteResult['task']; requireValue(createdTask, 'ACTION_TASK_REQUIRED', '应对任务未创建，请重试。'); task = createdTask; planVersion = created.planVersion; risk.actionTaskIds.push(createdTask.id); appendEvent(risk, 'create_action', actor.name, `创建并关联应对任务：${createdTask.title}（${createdTask.id}）`, now);
          }
        }
      }
      if (risk) captureRiskActivity(db, projectId, actor, activityBefore, risk, operation);
      if (risk) { risk.updatedAt = now.toISOString(); saveRisk(db, projectId, risk); risk = projectRiskResponsibilities(risk, workspace.responsibilityCandidates); }
      result = { ...(risk ? { risk } : {}), ...(alert ? { alert } : {}), ...(task ? { task } : {}), version: bumpRevision(db, projectId), planVersion };
    }
    captureProjectEvents(db, projectId, now);
    db.prepare('INSERT INTO risk_idempotency VALUES (?,?,?,?)').run(projectId, key, hash, JSON.stringify(result)); return result;
  })();
}
