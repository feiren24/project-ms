<script setup lang="ts">
import { operationReasonPolicy } from '../../../../shared/src/operation-reasons';

import { isProjectManager, canWriteProject } from '../../../../shared/src/permissions';

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { ManagedRisk, RiskAction, RiskDraft, RiskWorkspace, RiskAlert, RiskMutation } from '../../../../shared/src/risks';
import type { TaskDraft } from '../../../../shared/src/tasks';
import { createRisk, updateRisk, transitionRisk, linkRiskTask, createRiskTask, handoverRiskResponsibilities } from '../../api/risks';
import { PlanningError } from '../../api/planning';
import { actions, states, riskLevel, levels, levelFor, dateTime } from './labels';
import '../tasks/task-drawer.css';
const props = defineProps<{ workspace: RiskWorkspace; risk: ManagedRisk | null; actorId: string; sourceAlert?: RiskAlert | null; initialWorkstreamId?: string }>();
const emit = defineEmits<{ close: []; saved: [message: string, id?: string]; reload: []; task: [id: string]; alert: [id: string] }>();
const dialog = ref<HTMLDialogElement>();
const editing = ref(!props.risk), busy = ref(false), error = ref(''), notice = ref(''), stale = ref(false), reloading = ref(false), confirmed = ref(false);
const mode = ref<RiskAction | 'responsibilities' | 'link' | 'remove' | 'create_task' | null>(null), reason = ref(''), reviewDate = ref(props.risk?.reviewDate || ''), selectedTask = ref('');
const reasonPolicy = computed(() => mode.value === 'responsibilities' ? 'required' : operationReasonPolicy({ domain: 'risk', action: editing.value ? 'update' : mode.value ?? '', selfReview: props.actorId === props.risk?.ownerId || props.actorId === props.risk?.closure?.submittedBy }));
const directConfirm = computed(() => !editing.value && reasonPolicy.value === 'hidden' && !!mode.value && !['link', 'create_task'].includes(mode.value));
const expectedVersion = ref(props.risk?.version || 0), expectedPlanVersion = ref(props.workspace.planVersion);
const actor = computed(() => props.workspace.actors.find(a => a.id === props.actorId));
const manager = computed(() => isProjectManager(actor.value?.role));
const writable = computed(() => manager.value);
const executor = computed(() => manager.value);
const unlocked = computed(() => !props.risk || !['closed', 'pending_close'].includes(props.risk.status));
const editable = computed(() => props.risk ? executor.value && unlocked.value && !props.risk.needsHandover : writable.value);
const draft = reactive<RiskDraft>({ title: props.risk?.title || props.sourceAlert?.title || '', description: props.risk?.description || props.sourceAlert?.evidence || '', workstreamId: props.risk?.workstreamId || props.sourceAlert?.workstreamId || props.initialWorkstreamId || props.workspace.workstreams[0]?.id || '', ownerId: props.risk?.ownerId || (props.workspace.responsibilityCandidates.some(p => p.id === props.actorId) ? props.actorId : props.workspace.responsibilityCandidates[0]?.id || '') , probability: props.risk?.probability ?? null, impact: props.risk?.impact ?? null, due: props.risk?.due || props.workspace.project.end, reviewDate: props.risk?.reviewDate || null, response: props.risk?.response || '', taskIds: [...(props.risk?.taskIds || props.sourceAlert?.taskIds || [])].filter(id => props.workspace.tasks.some(t => t.id === id && t.taskKind !== 'summary' && !t.isContainer && (!!props.risk || t.status !== 'cancelled'))), closeReviewerId: props.risk?.closeReviewerId || null });
const responseGroupInactive = computed(() => props.workspace.workstreams.find(s => s.id === props.risk?.workstreamId)?.active === false);
const taskDraft = reactive<TaskDraft>({ title: '', description: '', workstreamId: props.risk?.workstreamId || draft.workstreamId, parentId: null, ownerId: props.risk?.ownerId || (actor.value?.assignable !== false ? props.actorId : ''), priority: 'P1', effortHours: 8, requiresReview: false, reviewerId: null, acceptanceCriteria: '', evidence: '', start: props.workspace.today, end: props.risk?.due || props.workspace.project.end });
const residualReasons = reactive<Record<string, string>>({});
const snapshot = ref(JSON.stringify(draft)), taskSnapshot = ref(JSON.stringify(taskDraft));
const dirty = computed(() => (mode.value === 'responsibilities' && JSON.stringify(handover) !== handoverSnapshot) || JSON.stringify(draft) !== snapshot.value || JSON.stringify(taskDraft) !== taskSnapshot.value || !!reason.value.trim() || (mode.value === 'link' && !!selectedTask.value) || Object.values(residualReasons).some(Boolean) || reviewDate.value !== (props.risk?.reviewDate || ''));
const ownerOptions = computed(() => props.workspace.responsibilityCandidates);
const reviewerOptions = ownerOptions;
const initialResponsibility = (id: string | null | undefined) => ownerOptions.value.some(p => p.id === id) ? id! : '';
const handover = reactive({ ownerId: initialResponsibility(props.risk?.ownerId), closeReviewerId: initialResponsibility(props.risk?.closeReviewerId) });
const handoverSnapshot = JSON.stringify(handover);
const taskOptions = computed(() => props.workspace.tasks.filter(t => t.taskKind !== 'summary' && !t.isContainer && t.status !== 'cancelled'));
const impactTaskOptions = computed(() => props.workspace.tasks.filter(t => t.taskKind !== 'summary' && !t.isContainer && (t.status !== 'cancelled' || props.risk?.taskIds.includes(t.id))));
const sourceTasksExcluded = computed(() => !props.risk && (props.sourceAlert?.taskIds || []).some(id => !taskOptions.value.some(t => t.id === id)));
const actionTasks = computed(() => (props.risk?.actionTaskIds || []).map(id => props.workspace.tasks.find(t => t.id === id)).filter(t => !!t));
const unresolved = computed(() => actionTasks.value.filter(t => t.status !== 'done' || (t.requiresReview && t.reviewStatus !== 'accepted')));
const canReview = computed(() => !!props.risk && manager.value && props.risk.status === 'pending_close');
const availableActions = computed<RiskAction[]>(() => {
  const r = props.risk;
  if (!r) return [];
  if (r.status === 'pending_close') return canReview.value ? ['approve_close', 'reject_close'] : [];
  if (!executor.value) return [];
  if (r.status === 'closed') return ['reopen'];
  const result: RiskAction[] = [];
  if (r.status === 'identified' && r.score !== null) result.push('assess');
  if (r.status === 'assessed') result.push('mitigate');
  if (r.status === 'mitigating') result.push('monitor');
  if (r.score !== null && ['assessed', 'mitigating', 'monitoring'].includes(r.status)) result.push('accept');
  if (r.score !== null && ['mitigating', 'monitoring'].includes(r.status) && (manager.value || r.ownerId === props.actorId)) result.push('submit_close');
  if (!r.occurred) result.push('occur');
  return result;
});
const score = computed(() => draft.probability !== null && draft.impact !== null ? Number(draft.probability) * Number(draft.impact) : null);
const actorName = (id: string | null) => props.workspace.actors.find(a => a.id === id)?.name ?? props.workspace.people?.find(person => person.id === id)?.name ?? (id ? '成员资料不可用' : '由项目负责人复核');
const taskName = (id: string) => props.workspace.tasks.find(t => t.id === id)?.title || id;
const confirmLeave = ref(false);
let pendingLeave: (() => void) | null = null, navigationResolve: ((allowed: boolean) => void) | null = null;
function revealLeave() { confirmLeave.value = true; nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.td-leave-panel'); panel?.scrollIntoView({ block: 'nearest' }); panel?.querySelector('button')?.focus(); }); }
function leave(callback = () => emit('close')) { if (busy.value) return; if (dirty.value) { pendingLeave = callback; revealLeave(); } else callback(); }
function confirmNavigation(): Promise<boolean> { if (busy.value) return Promise.resolve(false); if (!dirty.value) return Promise.resolve(true); return new Promise(resolve => { navigationResolve?.(false); navigationResolve = resolve; pendingLeave = () => { navigationResolve?.(true); navigationResolve = null; }; revealLeave(); }); }
function discard() { confirmLeave.value = false; const callback = pendingLeave; pendingLeave = null; callback?.(); }
function keep() { confirmLeave.value = false; pendingLeave = null; navigationResolve?.(false); navigationResolve = null; }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
function cancelForm() { leave(() => { Object.assign(draft, JSON.parse(snapshot.value)); Object.assign(taskDraft, JSON.parse(taskSnapshot.value)); reason.value = ''; selectedTask.value = ''; Object.assign(handover, JSON.parse(handoverSnapshot)); Object.keys(residualReasons).forEach(k => delete residualReasons[k]); reviewDate.value = props.risk?.reviewDate || ''; mode.value = null; confirmed.value = false; editing.value = false; }); }
function stage(action: typeof mode.value) { mode.value = action; reason.value = ''; error.value = ''; confirmed.value = directConfirm.value; nextTick(() => dialog.value?.querySelector<HTMLElement>('.rd-operation')?.scrollIntoView({ block: 'nearest' })); }
function normalizedDraft(): RiskDraft { return { ...draft, title: draft.title.trim(), reviewDate: draft.reviewDate || null, probability: draft.probability === null ? null : Number(draft.probability), impact: draft.impact === null ? null : Number(draft.impact) }; }
function review() {
  error.value = '';
  if (mode.value === 'responsibilities' && (!manager.value || !ownerOptions.value.some(p => p.id === handover.ownerId) || !ownerOptions.value.some(p => p.id === handover.closeReviewerId))) { error.value = '请选择有效的接手责任人和关闭复核人。'; return; }
  if (mode.value === 'create_task' && responseGroupInactive.value) { error.value = '此工作分组已停用，请先启用分组后再创建应对任务。已有任务仍可关联和处理。'; return; }
  if (editing.value) {
    if (!draft.title.trim() || !draft.ownerId || !draft.workstreamId || !draft.due) { error.value = '请填写风险名称、工作分组、责任人与处理期限。'; return; }
    if ((draft.probability === null) !== (draft.impact === null)) { error.value = '概率与影响需同时填写，或同时保持待评估。'; return; }
  }
  if (reasonPolicy.value === 'required' && !reason.value.trim()) { error.value = '此高危操作须填写原因或依据。'; return; }
  if (mode.value === 'accept' && (!reviewDate.value || reviewDate.value <= props.workspace.today)) { error.value = '接受风险需设置未来复查日期。'; return; }
  if (mode.value === 'submit_close' && unresolved.value.some(t => !residualReasons[t.id]?.trim())) { error.value = '请逐项填写未完成应对任务的剩余风险接受理由。'; return; }
  if (mode.value === 'link' && !selectedTask.value) { error.value = '请选择要关联的执行任务。'; return; }
  confirmed.value = true;
}
let signature = '', requestKey = '';
function keyFor(payload: unknown) { const next = JSON.stringify({ payload, mode: mode.value, actor: props.actorId, token: props.workspace.writeToken }); if (next !== signature) { signature = next; requestKey = crypto.randomUUID(); } return requestKey; }
async function save() {
  if (busy.value || stale.value || !confirmed.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const w = props.workspace, r = props.risk; let result;
    if (editing.value) {
      const body = normalizedDraft();
      result = r ? await updateRisk(w, props.actorId, r.id, body, expectedVersion.value, reason.value.trim(), keyFor({ body, version: expectedVersion.value, reason: reason.value.trim() })) : await createRisk(w, props.actorId, body, keyFor({ body, source: props.sourceAlert?.id }), props.sourceAlert?.id);
    } else if (r && mode.value === 'responsibilities') {
      if (!manager.value) throw new Error('当前身份无风险移交权限，请保留草稿并读取最新记录。');
      const body = { expectedVersion: expectedVersion.value, ...handover, reason: reason.value.trim() };
      result = await handoverRiskResponsibilities(w, props.actorId, r.id, body, keyFor(body));
    } else if (r && mode.value === 'create_task') {
      const body = { expectedVersion: expectedVersion.value, expectedPlanVersion: expectedPlanVersion.value, draft: { ...taskDraft, title: taskDraft.title.trim(), effortHours: Number(taskDraft.effortHours), reviewerId: taskDraft.requiresReview ? taskDraft.reviewerId : null } };
      result = await createRiskTask(w, props.actorId, r.id, body, keyFor(body));
    } else if (r && (mode.value === 'link' || mode.value === 'remove')) {
      const body = { expectedVersion: expectedVersion.value, taskId: selectedTask.value, reason: reason.value.trim(), remove: mode.value === 'remove' };
      result = await linkRiskTask(w, props.actorId, r.id, body, keyFor(body));
    } else if (r && mode.value) {
      if (!availableActions.value.includes(mode.value as RiskAction)) throw new Error('当前身份或风险状态已变化，请重新读取并核对。');
      const body: RiskMutation = { expectedVersion: expectedVersion.value, action: mode.value as RiskAction, reason: reason.value.trim(), ...(mode.value === 'accept' ? { reviewDate: reviewDate.value } : {}), ...(mode.value === 'submit_close' ? { residualReasons: { ...residualReasons } } : {}) };
      result = await transitionRisk(w, props.actorId, r.id, body, keyFor(body));
    }
    if (!result) throw new Error('没有可保存的操作。');
    snapshot.value = JSON.stringify(draft); taskSnapshot.value = JSON.stringify(taskDraft); reason.value = ''; selectedTask.value = ''; Object.keys(residualReasons).forEach(k => delete residualReasons[k]);
    emit('saved', mode.value === 'responsibilities' ? '风险责任已移交，原因和操作记录已保存。' : '风险操作已保存，活动记录与项目总览已同步。', result.risk?.id);
  } catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试。'; stale.value = e instanceof PlanningError && [403, 409].includes(e.status); }
  finally { busy.value = false; }
}
function reload() { reloading.value = true; emit('reload'); }
watch(() => props.workspace, () => {
  if (!reloading.value) return;
  if (props.risk) {
    // Existing-risk responsibilities are read-only here and may have been handed over concurrently.
    // Rebase their cancellation baseline too, while keeping all editable fields and drafts intact.
    const responsibilities = { ownerId: props.risk.ownerId, closeReviewerId: props.risk.closeReviewerId };
    Object.assign(draft, responsibilities);
    snapshot.value = JSON.stringify({ ...JSON.parse(snapshot.value), ...responsibilities });
  }
  expectedVersion.value = props.risk?.version || 0; expectedPlanVersion.value = props.workspace.planVersion;
  stale.value = false; reloading.value = false; confirmed.value = directConfirm.value; error.value = '';
  notice.value = directConfirm.value ? '已读取最新记录，请核对当前对象与状态后重新确认。' : '已读取最新记录，草稿仍保留。请对照最新状态与记录，重新核对后提交。'; signature = '';
});
defineExpose({ confirmNavigation });
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); navigationResolve?.(false); dialog.value?.close(); });
</script>
<template>
<dialog ref="dialog" class="task-drawer risk-drawer" aria-labelledby="rd-title" :aria-busy="busy" @cancel.prevent="leave()">
 <div class="td-shell">
  <header class="td-header"><div class="td-header-row"><span class="td-reference">{{ risk?.id || '登记风险' }}<span v-if="workspace.project.isDemo"> · DEMO · 示例项目</span></span><button class="td-icon-button" aria-label="关闭风险详情" :disabled="busy" @click="leave()">×</button></div><h2 id="rd-title" :title="risk?.title">{{ risk?.title || (sourceAlert ? '从预警登记风险' : '登记风险') }}</h2><p class="td-stream">{{ workspace.project.name }} · {{ actor?.name }}（当前操作者）</p><div v-if="risk" class="td-badges"><span class="td-state">{{ states[risk.status] }}</span><span class="risk-level" :class="`risk-level-${risk.level || risk.legacyLevel}`">{{ riskLevel(risk) }}</span><span v-if="risk.occurred" class="td-block-label">已发生</span></div></header>
  <div class="td-body">
   <div v-if="confirmLeave" class="td-leave-panel" role="alert"><strong>保留未保存内容？</strong><p>离开将丢弃这次填写内容，已保存记录不会改变。</p><div class="td-inline-buttons"><button class="button" @click="keep">继续填写</button><button class="button" @click="discard">放弃草稿并继续</button></div></div>
   <div v-if="error" class="td-error" role="alert">{{ error }}<button v-if="stale" class="td-text-button" @click="reload">保留草稿并读取最新记录</button></div>
   <p v-if="notice" class="td-notice" role="status">{{ notice }}</p>
   <p v-if="!writable" class="td-callout">当前身份无风险管理权限，请返回可访问的项目页面。</p>
   <p v-if="risk?.score === null" class="td-callout">此风险待人工评分。先编辑风险，填写概率与影响，再完成评估。<span v-if="risk.legacyLevel">历史示例等级仅作参考。</span></p>
   <p v-if="risk?.status === 'pending_close'" class="td-callout">关闭申请待复核，评估与应对措施已锁定。指定复核人：{{ actorName(risk.closeReviewerId) }}；项目负责人和管理员可处理全部复核，自审须说明理由。</p>
   <p v-if="risk?.needsHandover" class="td-callout" role="status">需要责任移交：{{ risk.responsibilityIssues?.includes('owner') ? '责任人' : '' }}{{ risk.responsibilityIssues?.length === 2 ? '、' : '' }}{{ risk.responsibilityIssues?.includes('closeReviewer') ? '关闭复核人' : '' }}已不符合管理职责要求，请移交给已启用的项目负责人或项目管理员。</p>
   <p v-else-if="risk?.status === 'closed' && risk.responsibilityIssues?.length" class="td-callout">已关闭风险保留历史责任记录；重开前须完成责任移交。</p>
   <form v-if="editing" id="risk-edit-form" class="td-form" @submit.prevent="review">
    <fieldset :disabled="busy || confirmed || !editable || stale">
     <label class="td-field">风险标题<input v-model="draft.title" required maxlength="200"/></label>
     <label class="td-field">原因与影响<textarea v-model="draft.description" rows="3" maxlength="4000"></textarea></label>
     <div class="td-form-grid"><label class="td-field">工作分组<select v-model="draft.workstreamId" required><option v-for="s in workspace.workstreams" :key="s.id" :value="s.id">{{ s.name }}</option></select></label><label class="td-field">责任人<select v-model="draft.ownerId" required :disabled="!!risk"><option v-for="person in ownerOptions" :key="person.id" :value="person.id" :disabled="person.role === 'viewer' && person.id !== risk?.ownerId">{{ person.name }}{{ person.role === 'viewer' ? ' · 历史责任（只读）' : '' }}</option></select></label></div>
     <div class="td-form-grid"><label class="td-field">发生概率<select v-model="draft.probability"><option :value="null">待评估</option><option v-for="n in 5" :key="n" :value="n">{{ n }} · {{ ['极低','较低','中等','较高','极高'][n-1] }}</option></select></label><label class="td-field">影响程度<select v-model="draft.impact"><option :value="null">待评估</option><option v-for="n in 5" :key="n" :value="n">{{ n }} · {{ ['很小','较小','中等','较大','重大'][n-1] }}</option></select></label></div>
     <p class="td-callout">{{ score === null ? '待人工评估；历史等级不会推导成概率或影响。' : `评分 ${score} / 25 · ${levels[levelFor(score)]}风险。1–4低，5–9中，10–16高，17–25严重。` }}</p>
     <div class="td-form-grid"><label class="td-field">处理期限<input v-model="draft.due" type="date" required/></label><label class="td-field">下次复查<input v-model="draft.reviewDate" type="date"/></label></div>
     <label class="td-field">关闭复核人<select v-model="draft.closeReviewerId" :disabled="!!risk"><option :value="null">由项目负责人或管理员复核</option><option v-for="p in reviewerOptions" :key="p.id" :value="p.id">{{ p.name }}</option></select><small>仅可指定本项目已启用的负责人或项目管理员；管理人员自审需说明理由。已有风险请通过“移交责任”变更。</small></label>
     <label class="td-field">应对措施<textarea v-model="draft.response" rows="3" maxlength="4000"></textarea></label>
     <label class="td-field">影响任务<select v-model="draft.taskIds" multiple size="5" aria-label="影响任务"><option v-for="t in impactTaskOptions" :key="t.id" :value="t.id">{{ t.wbs }} {{ t.title }}{{ t.status === 'cancelled' ? ' · 已取消（历史影响关联，可取消选择）' : '' }}</option></select><small>可多选；影响任务与应对任务分别记录。</small><small v-if="sourceTasksExcluded">预警中已取消或不适用的任务未预选，原始触发证据仍保留。</small></label>
    </fieldset>
   </form>
   <template v-else-if="risk">
    <dl class="td-facts"><div><dt>责任人</dt><dd>{{ risk.owner }}</dd></div><div><dt>处理期限</dt><dd>{{ risk.due }}</dd></div><div><dt>概率 × 影响</dt><dd>{{ risk.probability ?? '待评估' }} × {{ risk.impact ?? '待评估' }}</dd></div><div><dt>评分</dt><dd>{{ risk.score ?? '待评估' }}</dd></div><div><dt>复查日期</dt><dd :class="{'orange-text':risk.reviewDate && risk.reviewDate < workspace.today && risk.status !== 'closed'}">{{ risk.reviewDate || '未设置' }}{{ risk.reviewDate && risk.reviewDate < workspace.today && risk.status !== 'closed' ? ' · 复查逾期' : '' }}</dd></div><div><dt>独立关闭复核人</dt><dd>{{ actorName(risk.closeReviewerId) }}</dd></div></dl>
    <h3>风险说明</h3><p class="td-prose">{{ risk.description || '暂无补充说明' }}</p><section class="td-section"><h3>应对方案</h3><p class="td-prose">{{ risk.response || '暂未填写，可由责任人或项目负责人完善。' }}</p><p v-if="risk.acceptanceReason" class="td-callout">接受原因：{{ risk.acceptanceReason }}</p></section>
    <section v-if="risk.sourceAlertId" class="td-section"><h3>来源预警</h3><button class="td-text-button" @click="leave(()=>emit('alert',risk!.sourceAlertId!))">查看来源预警与证据</button></section>
    <section class="td-section"><h3>影响任务</h3><p v-if="!risk.taskIds.length" class="td-empty-inline">暂无影响任务，可在编辑风险中补充。</p><button v-for="id in risk.taskIds" :key="id" class="td-related-task" @click="leave(()=>emit('task',id))">{{ taskName(id) }} ↗</button></section>
    <section class="td-section"><h3>应对任务 · {{ actionTasks.length }}</h3><p v-if="!actionTasks.length" class="td-empty-inline">尚未关联应对任务。责任人可关联执行任务，项目负责人也可创建并关联。</p><div v-for="t in actionTasks" :key="t.id" class="risk-action-item"><button class="td-related-task" @click="leave(()=>emit('task',t.id))"><span><strong>{{ t.title }}</strong><small>{{ t.owner }} · {{ t.status === 'done' ? '已完成' : t.status === 'cancelled' ? '已取消（需处理剩余风险）' : '未完成' }} · V{{ t.version }}</small></span>↗</button><button v-if="executor && unlocked && !mode" class="td-text-button" @click="stage('remove'); selectedTask=t.id">移除关联</button></div><div v-if="executor && unlocked && !mode" class="td-inline-buttons"><button class="button" @click="stage('link')">关联已有任务</button><button v-if="manager" class="button" :disabled="responseGroupInactive" @click="stage('create_task')">创建应对任务</button></div><p v-if="responseGroupInactive" class="td-field-note">所属工作分组已停用，已有应对任务可继续处理；启用后才能创建新的应对任务。</p></section>
    <section v-if="risk.closure" class="td-section"><h3>关闭申请快照</h3><p class="td-prose">{{ risk.closure.reason }}</p><p class="td-field-note">提交人：{{ actorName(risk.closure.submittedBy) }}。复核会重新检查任务版本与完成状态。</p><p v-if="risk.closure.reviewedById" class="td-field-note">实际复核：{{ actorName(risk.closure.reviewedById) }}{{ risk.closure.selfReview ? ' · 管理员自审' : '' }}<span v-if="risk.closure.reviewedAt"> · {{ dateTime(risk.closure.reviewedAt) }}</span></p><ul class="risk-history-list"><li v-for="(version,id) in risk.closure.taskVersions" :key="id">{{ taskName(String(id)) }} · 提交时 V{{ version }}<p v-if="risk.closure.residualReasons[String(id)]">剩余风险接受理由：{{ risk.closure.residualReasons[String(id)] }}</p></li></ul></section>
   </template>
   <section v-if="mode" class="td-action-panel rd-operation"><h3>{{ mode === 'responsibilities' ? '移交责任' : mode === 'link' ? '关联已有任务' : mode === 'remove' ? '移除应对任务关联' : mode === 'create_task' ? '创建并关联应对任务' : actions[mode] }}</h3><p v-if="manager && risk && ['approve_close', 'reject_close'].includes(mode) && (risk.ownerId === actorId || risk.closure?.submittedBy === actorId)" class="td-warning-text" role="note">你正在复核自己负责或提交的风险。请填写自审理由，确认后保留实际操作者和自审记录。</p><p class="td-prose">对象：{{ risk?.title }}。本次操作将记录 {{ actor?.name }}、时间与变更内容。</p>
    <form id="risk-action-form" class="td-form" @submit.prevent="review"><fieldset :disabled="busy || confirmed || stale">
     <template v-if="mode === 'create_task'"><label class="td-field">应对任务名称<input v-model="taskDraft.title" required maxlength="200"/></label><label class="td-field">任务说明<textarea v-model="taskDraft.description" rows="2"></textarea></label><label class="td-field">任务负责人<select v-model="taskDraft.ownerId" required><option v-for="p in workspace.actors.filter(a=>a.assignable!==false && a.role!=='viewer')" :key="p.id" :value="p.id">{{ p.name }}</option></select></label><div class="td-form-grid"><label class="td-field">开始日期<input v-model="taskDraft.start" type="date" required/></label><label class="td-field">截止日期<input v-model="taskDraft.end" type="date" required/></label></div><div class="td-form-grid"><label class="td-field">估算工时<input v-model.number="taskDraft.effortHours" type="number" min="0.5" step="0.5" required/></label><label class="td-field">优先级<select v-model="taskDraft.priority"><option>P0</option><option>P1</option><option>P2</option></select></label></div><label class="td-check"><input v-model="taskDraft.requiresReview" type="checkbox"/>需要任务验收</label><template v-if="taskDraft.requiresReview"><label class="td-field">任务验收人<select v-model="taskDraft.reviewerId" required><option :value="null" disabled>请选择</option><option v-for="p in workspace.actors.filter(a=>a.assignable!==false && canWriteProject(a.role) && (a.id!==taskDraft.ownerId || isProjectManager(a.role)))" :key="p.id" :value="p.id">{{ p.name }}</option></select></label><label class="td-field">任务验收标准<textarea v-model="taskDraft.acceptanceCriteria" required rows="2"></textarea></label></template><p class="td-field-note">任务与风险关联将一起保存，任一步失败均不创建孤立任务。</p></template>
     <template v-if="mode === 'responsibilities'"><p class="td-field-note">当前责任人：{{ actorName(risk?.ownerId || null) }}；关闭复核人：{{ actorName(risk?.closeReviewerId || null) }}。移交保留当前风险状态、关闭申请及历史复核记录。</p><p v-if="!ownerOptions.length" class="td-callout">暂无可接手的管理成员，请先在成员与设置中配置已启用的项目负责人或项目管理员，再读取最新记录。</p><label class="td-field">接手责任人<select v-model="handover.ownerId" required><option value="" disabled>选择项目管理成员</option><option v-for="p in ownerOptions" :key="p.id" :value="p.id">{{ p.name }}</option></select></label><label class="td-field">接手关闭复核人<select v-model="handover.closeReviewerId" required><option value="" disabled>选择项目管理成员</option><option v-for="p in reviewerOptions" :key="p.id" :value="p.id">{{ p.name }}</option></select></label></template>
     <label v-if="mode === 'link'" class="td-field">关联应对任务<select v-model="selectedTask" required><option value="" disabled>选择本项目执行任务</option><option v-for="t in taskOptions.filter(t=>!risk?.actionTaskIds.includes(t.id))" :key="t.id" :value="t.id">{{ t.wbs }} {{ t.title }}</option></select></label><p v-if="mode === 'remove'" class="td-field-note">仅移除“{{ taskName(selectedTask) }}”的应对关联，任务本身保留。</p>
     <label v-if="reasonPolicy !== 'hidden'" class="td-field">{{ mode === 'responsibilities' ? '移交原因' : mode === 'accept' ? '接受风险原因' : mode === 'submit_close' ? '关闭理由' : mode === 'approve_close' || mode === 'reject_close' ? '复核意见' : '操作原因' }}{{ reasonPolicy === 'optional' ? '（选填）' : '' }}<textarea v-model="reason" rows="3" :required="reasonPolicy === 'required'" maxlength="1500"></textarea></label>
     <label v-if="mode === 'accept'" class="td-field">下次复查日期<input v-model="reviewDate" type="date" :min="workspace.today" required/><small>接受后进入监控，不会直接关闭风险。</small></label>
     <template v-if="mode === 'submit_close'"><p class="td-field-note">由责任人或管理人员提交，指定复核人或管理人员批准。未完成任务须逐项接受剩余风险。</p><label v-for="t in unresolved" :key="t.id" class="td-field">剩余风险理由：{{ t.title }}<textarea v-model="residualReasons[t.id]" rows="2" required></textarea></label></template>
    </fieldset></form>
   </section>
   <section v-if="confirmed" class="td-action-panel" role="status"><h3>请核对后确认</h3><p class="td-prose">{{ editing ? `保存风险「${draft.title}」，责任人 ${actorName(draft.ownerId)}，处理期限 ${draft.due}，${score === null ? '待人工评分' : '评分 ' + score}。` : mode === 'responsibilities' ? `将风险「${risk?.title}」的责任人移交给 ${actorName(handover.ownerId)}，关闭复核人改为 ${actorName(handover.closeReviewerId)}。原因：${reason}。` : mode === 'create_task' ? `创建任务「${taskDraft.title}」，责任人 ${actorName(taskDraft.ownerId)}，${taskDraft.start} 至 ${taskDraft.end}，${taskDraft.effortHours} 小时，并关联当前风险。` : `${mode && mode in actions ? actions[mode as RiskAction] : mode === 'remove' ? '移除关联' : '关联任务'}${reason ? '：' + reason : ''}` }}</p><p class="td-field-note">操作人 {{ actor?.name }}。{{ mode === 'approve_close' ? '复核通过后风险将关闭，并保留本次实际操作者与复核记录。' : '' }}</p><button v-if="!directConfirm" class="td-text-button" :disabled="busy" @click="confirmed=false">返回修改</button></section>
   <section v-if="risk" class="td-section"><h3>活动记录</h3><p v-if="!risk.events.length" class="td-empty-inline">暂无活动记录。</p><article v-for="event in [...risk.events].reverse()" :key="event.id" class="td-event"><div><h4>{{ event.actor }} · {{ event.action }}</h4><p class="td-prose">{{ event.text }}</p><time>{{ dateTime(event.createdAt) }}</time></div></article></section>
  </div>
  <footer class="td-footer"><template v-if="editing || mode"><button class="button" :disabled="busy" @click="risk ? cancelForm() : leave()">取消</button><button v-if="!confirmed" class="button primary" :form="editing?'risk-edit-form':'risk-action-form'" :disabled="busy || stale || (editing && !editable)">核对操作</button><button v-else class="button primary" :disabled="busy || stale" @click="save">{{ busy ? '正在保存…' : editing ? '确认保存风险' : mode === 'responsibilities' ? '确认移交责任' : mode === 'create_task' ? '确认创建并关联' : mode === 'link' ? '确认关联任务' : mode === 'remove' ? '确认移除关联' : `确认${actions[mode!]}` }}</button></template><template v-else><button v-if="editable" class="button" @click="editing=true">编辑风险</button><div class="td-secondary-actions"><button v-if="risk && manager" class="td-text-button" @click="stage('responsibilities')">移交责任</button><button v-for="a in availableActions" :key="a" class="td-text-button" @click="stage(a)">{{ actions[a] }}</button></div><button v-if="!editable && !availableActions.length" class="button" @click="leave()">返回风险台账</button></template></footer>
 </div>
</dialog>
</template>
