import { isProjectManager } from '../../../../shared/src/permissions.js';
import type { ManagedRisk, RiskDraft, RiskWorkspace } from '../../../../shared/src/risks.js';
import type { TaskActor } from '../../../../shared/src/tasks.js';
import { validDate } from '../planning/calendar.js';
import { PlanError, requireValue } from '../planning/errors.js';
export const draftKeys = ['title', 'description', 'workstreamId', 'ownerId', 'probability', 'impact', 'due', 'reviewDate', 'response', 'taskIds', 'closeReviewerId'];
export function strict(body: unknown, keys: string[]): asserts body is Record<string, unknown> {
  requireValue(body && typeof body === 'object' && !Array.isArray(body), 'INVALID_REQUEST', '请填写有效风险内容。');
  requireValue(Object.keys(body).every(key => keys.includes(key)), 'UNKNOWN_FIELD', '包含不支持的字段，请保留草稿并刷新核对。');
}
export function textValue(value: unknown, field: string, max: number, required = false): string {
  requireValue(typeof value === 'string' && value.length <= max && (!required || value.trim().length > 0), 'INVALID_TEXT', `${field}${required ? '必填，' : ''}最多 ${max} 字。`); return value.trim();
}
export function checkVersion(current: number, expected: unknown) {
  requireValue(Number.isInteger(expected) && Number(expected) > 0, 'VERSION_REQUIRED', '请提供有效风险版本。');
  if (current !== expected) throw new PlanError(409, 'RISK_VERSION_CONFLICT', '风险内容已更新，请保留草稿并刷新核对。', { latestVersion: current });
}
export function writer(actorId: unknown, key: unknown, actors: TaskActor[]): TaskActor {
  const actor = actors.find(actor => actor.id === actorId);
  if (!actor || !isProjectManager(actor.role)) throw new PlanError(403, 'RISK_FORBIDDEN', '风险管理仅允许项目负责人、项目管理员或系统管理员操作。');
  requireValue(typeof key === 'string' && /^[\w:.-]{8,128}$/.test(key), 'IDEMPOTENCY_KEY_REQUIRED', '请提供 8–128 字符的唯一操作标识。'); return actor;
}
export function canMaintain(actor: TaskActor, risk: ManagedRisk) {
  if (!isProjectManager(actor.role)) throw new PlanError(403, 'RISK_FORBIDDEN', '仅风险责任人、项目负责人或管理员可以维护此风险。');
}
export function mutable(risk: ManagedRisk) { requireValue(!['pending_close', 'closed'].includes(risk.status), 'RISK_LOCKED', '风险正在关闭复核或已经关闭，请先退回关闭申请或重新打开。'); }
export function futureDate(value: unknown, today: string): string {
  requireValue(validDate(value) && value > today && value <= '2099-12-31', 'FUTURE_DATE_REQUIRED', '请选择晚于系统当前日的有效日期。'); return value;
}
export function executionTask(id: unknown, workspace: RiskWorkspace) {
  const task = workspace.tasks.find(task => task.id === id);
  requireValue(task && task.taskKind !== 'summary' && task.status !== 'cancelled', 'INVALID_ACTION_TASK', '只能关联本项目未取消的普通执行任务。'); return task;
}
export function validateDraft(body: Record<string, unknown>, workspace: RiskWorkspace, current?: ManagedRisk): RiskDraft {
  const title = textValue(body.title, '风险标题', 160, true); const description = textValue(body.description, '风险说明', 5000);
  requireValue(workspace.workstreams.some(stream => stream.id === body.workstreamId), 'WORKSTREAM_REQUIRED', '请选择本项目工作分组。');
  const actors = workspace.responsibilityCandidates;
  const owner = actors.find(actor => actor.id === body.ownerId);
  requireValue(owner, 'INVALID_OWNER', '风险责任人须为本项目已启用且可分派的项目负责人或项目管理员。');
  requireValue((body.probability === null && body.impact === null) || [body.probability, body.impact].every(v => Number.isInteger(v) && Number(v) >= 1 && Number(v) <= 5), 'INVALID_SCORE', '概率和影响必须同时留空或填写 1–5 的整数。');
  requireValue(validDate(body.due) && body.due <= '2099-12-31', 'INVALID_DUE', '请填写有效处理期限。');
  requireValue(body.reviewDate === null || (validDate(body.reviewDate) && body.reviewDate <= '2099-12-31'), 'INVALID_REVIEW_DATE', '复查日须为有效日期或留空。');
  if (current?.acceptanceReason && (body.reviewDate === null || body.reviewDate !== current.reviewDate)) futureDate(body.reviewDate, workspace.today);
  const reviewer = actors.find(actor => actor.id === body.closeReviewerId);
  requireValue(body.closeReviewerId === null || reviewer, 'INVALID_CLOSE_REVIEWER', '关闭复核人须为本项目已启用且可分派的项目负责人或项目管理员。');
  requireValue(Array.isArray(body.taskIds) && body.taskIds.length <= 100 && new Set(body.taskIds).size === body.taskIds.length, 'INVALID_TASK_IDS', '影响任务最多 100 条且不能重复。');
  for (const id of body.taskIds) {
    const historical = workspace.tasks.find(task => task.id === id && task.taskKind !== 'summary');
    if (current?.taskIds.includes(String(id)) && historical) continue;
    executionTask(id, workspace);
  }
  if (current && current.status !== 'identified') requireValue(body.probability !== null && body.impact !== null, 'ASSESSMENT_REQUIRED', '已评估风险不能清空人工概率与影响。');
  return { title, description, workstreamId: String(body.workstreamId), ownerId: owner.id, probability: body.probability as number | null, impact: body.impact as number | null, due: body.due, reviewDate: body.reviewDate as string | null, response: textValue(body.response, '应对措施', 5000), taskIds: body.taskIds as string[], closeReviewerId: body.closeReviewerId as string | null };
}
