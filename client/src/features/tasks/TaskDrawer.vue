<script setup lang="ts">
import { useRouter } from 'vue-router';
import { operationReasonPolicy } from '../../../../shared/src/operation-reasons';

import { isProjectManager, canWriteProject, canReviewTask } from '../../../../shared/src/permissions';

import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import { commentTask, createTask, mutateTask, previewParent, previewWorkstreamChange, updateTask } from '../../api/tasks';
import { PlanningError } from '../../api/planning';
import type { ManagedTask, TaskAction, TaskDraft, TaskMutation, TaskWorkspace, ParentPreview, ParentConfirmation, WorkstreamChangePreview } from '../../../../shared/src/tasks';
import './task-drawer.css';
import TaskPlanPanel from './TaskPlanPanel.vue';

const props = defineProps<{ workspace: TaskWorkspace; task: ManagedTask | null; actorId: string; initialAction?: TaskAction; initialWorkstreamId?: string; initialTab?: 'detail' | 'plan' | 'children' | 'activity'; initialPlanEditing?: boolean; planProposal?: { start: string; end: string }; backTaskLabel?: string }>();
const emit = defineEmits<{ planSaved: []; backTask: []; deleteTask: [task: ManagedTask]; close: []; manageWorkstreams: []; saved: [message: string, taskId?: string]; reload: []; showPlan: [taskId: string]; openTask: [taskId: string] }>();
const dialog = ref<HTMLDialogElement>();
const milestoneRouter = useRouter();
function showMilestones() { if (props.task) leave(() => { void milestoneRouter.push({name:'plan',params:{projectId:props.workspace.project.id},query:{view:'milestones',task:props.task!.id}}); }); }
const tab = ref<'detail' | 'plan' | 'children' | 'activity'>(props.initialTab ?? 'detail');
const planPanel = ref<InstanceType<typeof TaskPlanPanel>>();
const planActivated = ref(props.initialTab === 'plan' || !!props.initialPlanEditing);
const tabScroll: Partial<Record<typeof tab.value, number>> = {};
watch(tab, (value, previous) => {
  const body = dialog.value?.querySelector('.td-body'); if (body) tabScroll[previous] = body.scrollTop;
  if (value === 'plan') planActivated.value = true;
  void nextTick(() => { if (body) body.scrollTop = tabScroll[value] ?? 0; });
});
async function showInlinePlan() { tab.value = 'plan'; planActivated.value = true; await nextTick(); planPanel.value?.beginEdit(); }
function openMilestone(id: string) { leave(() => { void milestoneRouter.push({ name: 'plan', params: { projectId: props.workspace.project.id }, query: { view: 'milestones', milestone: id } }); }); }
const tabs = computed(() => [{ id: 'detail', name: '详情' }, { id: 'plan', name: '计划与依赖' }, { id: 'children', name: '子任务' }, { id: 'activity', name: '活动记录' }] as Array<{ id: 'detail' | 'plan' | 'children' | 'activity'; name: string }>);
const busy = ref(false), error = ref(''), notice = ref(''), stale = ref(false), reloading = ref(false);
const editing = ref(!props.task), confirmLeave = ref(false);
let pendingLeave: (() => void) | null = null;
let pendingNavigation: Promise<boolean> | null = null;
let resolveNavigation: ((allowed: boolean) => void) | null = null;
const expectedVersion = ref(props.task?.version ?? 0);
const expectedPlanVersion = ref(props.workspace.planVersion);
const expectedStructureVersion = ref(props.workspace.structureVersion);
function initialDraft(task: ManagedTask | null): TaskDraft {
  return {
    title: task?.title ?? '', description: task?.description ?? '', workstreamId: task?.workstreamId ?? (props.workspace.workstreams.some(s => s.id === props.initialWorkstreamId && s.active !== false) ? props.initialWorkstreamId : undefined) ?? props.workspace.workstreams.find(s => s.active !== false)?.id ?? '',
    parentId: task?.parentId ?? null, ownerId: task?.ownerId ?? props.workspace.actors.find(a => a.id === props.actorId && a.assignable !== false && canWriteProject(a.role))?.id ?? props.workspace.actors.find(a => a.assignable !== false && a.role !== 'viewer')?.id ?? '',
    priority: task?.priority ?? 'P1', effortHours: task?.effortHours ?? null, requiresReview: task?.requiresReview ?? false,
    reviewerId: task?.reviewerId ?? null, acceptanceCriteria: task?.acceptanceCriteria ?? '', evidence: task?.evidence ?? '',
    ...(!task ? { start: null, end: null } : {}),
  };
}
const selectableStreams = computed(() => props.workspace.workstreams.filter(s => s.active !== false || s.id === props.task?.workstreamId));
const selectedStreamInactive = computed(() => props.workspace.workstreams.find(s => s.id === draft.workstreamId)?.active === false);
const draft = reactive<TaskDraft>(initialDraft(props.task));
const draftSnapshot = ref(JSON.stringify(draft));
const action = ref<TaskAction | null>(props.initialAction ?? null), reason = ref('');
const actionProgress = ref(props.task?.status === 'done' ? 0 : Math.min(99, props.task?.progress ?? 0));
const actionEvidence = ref(props.task?.evidence ?? ''), comment = ref('');
const actor = computed(() => props.workspace.actors.find(a => a.id === props.actorId));
const manager = computed(() => isProjectManager(actor.value?.role));
const writable = computed(() => !!actor.value && actor.value.role !== 'viewer');
const canEditCommitment = computed(() => !workstreamOnly.value && (manager.value || (!props.task && writable.value)));
const executor = computed(() => writable.value && (manager.value || props.task?.ownerId === props.actorId));
const contentEditable = computed(() => !props.task ? writable.value : executor.value && !['done', 'cancelled'].includes(props.task.status) && props.task.reviewStatus !== 'submitted' && !isContainer.value);
const canChangeWorkstream = computed(() => !!props.task && !props.task.parentId && props.workspace.canChangeWorkstream === true);
const workstreamOnly = computed(() => !!props.task && !contentEditable.value);
const editable = computed(() => contentEditable.value || canChangeWorkstream.value);
const workstreamChanged = computed(() => !!props.task && draft.workstreamId !== props.task.workstreamId);
const classificationOnly = computed(() => {
  if (!workstreamChanged.value) return false;
  const original = JSON.parse(draftSnapshot.value) as TaskDraft;
  return Object.keys(draft).every(key => key === 'workstreamId' || draft[key as keyof TaskDraft] === original[key as keyof TaskDraft]);
});
const workstreamPreview = ref<WorkstreamChangePreview | null>(null), workstreamChecking = ref(false), workstreamError = ref('');
let workstreamRequest = 0;
const workstreamReady = computed(() => !workstreamChanged.value || (!!workstreamPreview.value && workstreamPreview.value.workstreamId === draft.workstreamId && !workstreamChecking.value && !workstreamError.value));
const children = computed(() => props.workspace.tasks.filter(t => t.parentId === props.task?.id));
const isContainer = computed(() => props.task?.taskKind === 'summary' || props.task?.isContainer === true || children.value.length > 0);
const parentSearch = ref('');
const parents = computed(() => props.workspace.tasks.filter(t => t.workstreamId === draft.workstreamId && t.parentId === null && (manager.value || t.parentEligibility?.mode === 'summary')));
const filteredParents = computed(() => parents.value.filter(t => t.id === draft.parentId || `${t.wbs} ${t.title}`.toLowerCase().includes(parentSearch.value.trim().toLowerCase())));
const selectedParent = computed(() => parents.value.find(t => t.id === draft.parentId));
const parentTask = computed(() => props.workspace.tasks.find(t => t.id === props.task?.parentId));
const hierarchyLabel = computed(() => {
  let depth = 1, node = props.task;
  const seen = new Set(node ? [node.id] : []);
  while (node?.parentId && !seen.has(node.parentId)) { depth++; seen.add(node.parentId); node = props.workspace.tasks.find(t => t.id === node!.parentId) ?? null; }
  return depth > 2 ? `历史第${depth}级任务` : '二级任务';
});
const eligibilityReason = (task: ManagedTask) => task.parentEligibility?.reason || '暂未获取可选条件，请重新读取任务。';
const parentPreview = ref<ParentPreview | null>(null);
const previewDraft = ref<TaskDraft | null>(null);
const previewActor = ref('');
function returnToEdit() { if (anyBusy.value) return; parentPreview.value = null; previewDraft.value = null; error.value = ''; }
const predecessors = computed(() => props.workspace.dependencies.filter(d => d.successorId === props.task?.id).map(d => ({ ...d, task: props.workspace.tasks.find(t => t.id === d.predecessorId) })));
const latestSubmission = computed(() => props.task?.submissions.filter(s => s.status === 'submitted').slice().sort((a, b) => b.version - a.version)[0]);
const reviewer = computed(() => !!props.task && !!latestSubmission.value && canReviewTask(actor.value?.role, props.actorId, props.task.ownerId, latestSubmission.value.submitterId, props.task.reviewerId));
const selfReview = computed(() => manager.value && !!props.task && ['accept', 'reject'].includes(action.value ?? '') && (props.task.ownerId === props.actorId || latestSubmission.value?.submitterId === props.actorId));
const actionNames: Record<TaskAction, string> = { start: '开始任务', complete: '标记完成', cancel: '取消任务', reopen: '重开任务', block: '标记阻塞', unblock: '解除阻塞', progress: '更新进度', submit: '提交验收', accept: '验收通过', reject: '退回修改' };
const confirmNames: Record<TaskAction, string> = { start: '确认开始', complete: '确认完成', cancel: '确认取消', reopen: '确认重开', block: '确认标记阻塞', unblock: '确认解除阻塞', progress: '确认更新进度', submit: '确认提交验收', accept: '确认验收通过', reject: '确认退回修改' };
const availableActions = computed<TaskAction[]>(() => {
  const t = props.task;
  if (!t) return [];
  if (isContainer.value) return manager.value && t.status === 'cancelled' ? ['reopen'] : [];
  if (reviewer.value && t.reviewStatus === 'submitted') return ['accept', 'reject'];
  if (!executor.value || t.reviewStatus === 'submitted') return [];
  if (t.status === 'done' || t.status === 'cancelled') return ['reopen'];
  const options: TaskAction[] = [];
  if (t.status === 'todo') options.push('start');
  if (t.status === 'in_progress') options.push(t.requiresReview ? 'submit' : 'complete', 'progress');
  options.push(t.blocked ? 'unblock' : 'block');
  if (manager.value) options.push('cancel');
  return options;
});
const initialProgress = ref(actionProgress.value);
const initialEvidence = ref(actionEvidence.value);
const reasonPolicy = computed(() => operationReasonPolicy({ domain: 'task', action: action.value ?? '', selfReview: selfReview.value }));
const actionDirty = computed(() => !!reason.value.trim() || actionEvidence.value !== initialEvidence.value || (['progress', 'reopen'].includes(action.value ?? '') && String(actionProgress.value) !== String(initialProgress.value)));
const taskDirty = computed(() => JSON.stringify(draft) !== draftSnapshot.value || !!comment.value.trim() || actionDirty.value);
const dirty = computed(() => taskDirty.value || !!planPanel.value?.isDirty);
const anyBusy = computed(() => busy.value || !!planPanel.value?.isBusy);
const ownerOptions = computed(() => props.workspace.actors.filter(a => a.assignable !== false && (a.role !== 'viewer' || a.id === props.task?.ownerId)));
const reviewerOptions = computed(() => props.workspace.actors.filter(a => a.assignable !== false && canWriteProject(a.role) && (a.id !== draft.ownerId || isProjectManager(a.role))));
const streamName = (id: string) => props.workspace.workstreams.find(s => s.id === id)?.name ?? id;
const actorName = (id: string | null) => props.workspace.actors.find(a => a.id === id)?.name ?? props.workspace.people?.find(person => person.id === id)?.name ?? (id ? '成员资料不可用' : '未指定');
const stateName = (task: Pick<ManagedTask, 'status' | 'reviewStatus'>) => task.reviewStatus === 'submitted' ? '待验收' : task.reviewStatus === 'needs_review' ? '待复核' : ({ todo: '待办', in_progress: '进行中', done: '已完成', cancelled: '已取消' }[task.status]);
const reviewName = (value: string) => ({ none: '未提交', submitted: '待验收', accepted: '已通过', rejected: '已退回', invalidated: '需重新提交', needs_review: '待复核' }[value] ?? value);
const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
function evidenceLinks(value: string) {
  return [...new Set(value.match(/https?:\/\/[^\s<>"']+/g) ?? [])].filter(value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } });
}
function leave(callback: () => void = () => dialog.value?.close()) {
  if (anyBusy.value) return;
  settleNavigation(false);
  if (dirty.value) { pendingLeave = callback; revealLeaveConfirmation(); }
  else callback();
}
function revealLeaveConfirmation() {
  confirmLeave.value = true;
  nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.td-leave-panel'); panel?.scrollIntoView({ block: 'nearest' }); panel?.querySelector<HTMLButtonElement>('button')?.focus(); });
}
function settleNavigation(allowed: boolean) {
  const resolve = resolveNavigation;
  resolveNavigation = null; pendingNavigation = null;
  resolve?.(allowed);
}
function confirmNavigation(): Promise<boolean> {
  if (anyBusy.value) return Promise.resolve(false);
  if (!dirty.value) return Promise.resolve(true);
  if (pendingNavigation) return pendingNavigation;
  pendingNavigation = new Promise<boolean>(resolve => { resolveNavigation = resolve; });
  pendingLeave = () => settleNavigation(true);
  revealLeaveConfirmation();
  return pendingNavigation;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!dirty.value && !anyBusy.value) return;
  event.preventDefault(); event.returnValue = '';
}
function discard() { confirmLeave.value = false; const callback = pendingLeave; pendingLeave = null; callback?.(); }
function keepEditing() { confirmLeave.value = false; pendingLeave = null; settleNavigation(false); }
function closeAction() {
  if (anyBusy.value) return;
  settleNavigation(false);
  const resetAction = () => { action.value = null; reason.value = ''; actionEvidence.value = initialEvidence.value; actionProgress.value = initialProgress.value; error.value = ''; };
  if (actionDirty.value) { pendingLeave = resetAction; revealLeaveConfirmation(); }
  else resetAction();
}
function stage(next: TaskAction) { action.value = next; reason.value = ''; error.value = ''; notice.value = ''; nextTick(() => dialog.value?.querySelector<HTMLElement>('.td-action-panel')?.scrollIntoView({ block: 'nearest' })); }
function startEdit() { editing.value = true; tab.value = 'detail'; }
async function checkWorkstream() {
  const request = ++workstreamRequest;
  workstreamPreview.value = null; workstreamError.value = ''; workstreamChecking.value = false;
  if (!workstreamChanged.value || !props.task || !canChangeWorkstream.value) return;
  workstreamChecking.value = true;
  try {
    const preview = await previewWorkstreamChange(props.workspace, props.actorId, props.task.id, draft.workstreamId);
    if (request === workstreamRequest) workstreamPreview.value = preview;
  } catch (e) {
    if (request === workstreamRequest) workstreamError.value = e instanceof Error ? e.message : '无法读取分组调整范围，请重试。';
  } finally { if (request === workstreamRequest) workstreamChecking.value = false; }
}
function cancelEdit() {
  settleNavigation(false);
  if (JSON.stringify(draft) !== draftSnapshot.value) { pendingLeave = () => { Object.assign(draft, JSON.parse(draftSnapshot.value)); editing.value = false; }; revealLeaveConfirmation(); }
  else editing.value = false;
}
let requestSignature = '', requestKey = '';
function keyFor(kind: string, payload: unknown) {
  const signature = JSON.stringify({ kind, payload, actor: props.actorId, token: props.workspace.writeToken });
  if (signature !== requestSignature) { requestSignature = signature; requestKey = crypto.randomUUID(); }
  return requestKey;
}
function failed(e: unknown) {
  error.value = e instanceof Error ? e.message : '暂时无法保存，请保留内容后重试。';
  stale.value = e instanceof PlanningError && [403, 409].includes(e.status);
}
function reload() { reloading.value = true; emit('reload'); }
watch(() => props.workspace, () => {
  if (!reloading.value) {
    if (!taskDirty.value) {
      expectedVersion.value = props.task?.version ?? 0; expectedPlanVersion.value = props.workspace.planVersion; expectedStructureVersion.value = props.workspace.structureVersion;
      Object.assign(draft, initialDraft(props.task)); draftSnapshot.value = JSON.stringify(draft);
      actionEvidence.value = props.task?.evidence ?? ''; initialEvidence.value = actionEvidence.value;
      actionProgress.value = props.task?.status === 'done' ? 0 : Math.min(99, props.task?.progress ?? 0); initialProgress.value = actionProgress.value;
    }
    return;
  }
  // Keep only fields the user actually changed; refresh untouched derived or locked
  // values (for example a summary's effort) before issuing another PATCH.
  const original = JSON.parse(draftSnapshot.value) as TaskDraft;
  const latest = initialDraft(props.task);
  const retained = Object.fromEntries(Object.entries(draft).filter(([key, value]) => value !== original[key as keyof TaskDraft]));
  Object.assign(draft, latest, retained);
  draftSnapshot.value = JSON.stringify(latest);
  expectedVersion.value = props.task?.version ?? 0; expectedPlanVersion.value = props.workspace.planVersion; expectedStructureVersion.value = props.workspace.structureVersion;
  parentPreview.value = null; previewDraft.value = null; requestSignature = ''; requestKey = '';
  reloading.value = false; stale.value = false; error.value = ''; notice.value = '已重新读取最新记录，填写内容仍保留。请核对后重新预览并确认保存。';
  void checkWorkstream();
});
watch(() => draft.workstreamId, () => { if (!props.task && draft.parentId && !parents.value.some(t => t.id === draft.parentId)) draft.parentId = null; });
watch(() => [draft.workstreamId, props.task?.id, props.task?.workstreamId, props.actorId, props.workspace.planVersion, props.workspace.canChangeWorkstream], () => { void checkWorkstream(); });
watch(() => props.actorId, () => { parentPreview.value = null; previewDraft.value = null; });
watch(() => draft.ownerId, () => { if (draft.ownerId !== JSON.parse(draftSnapshot.value).ownerId && !workstreamOnly.value && draft.reviewerId === draft.ownerId && !isProjectManager(props.workspace.actors.find(a => a.id === draft.ownerId)?.role)) draft.reviewerId = null; });
function normalizedDraft(): TaskDraft {
  if (workstreamOnly.value || classificationOnly.value) return { ...draft };
  return { ...draft, title: draft.title.trim(), effortHours: draft.effortHours === null || String(draft.effortHours) === '' ? null : Number(draft.effortHours), reviewerId: draft.requiresReview ? draft.reviewerId : null };
}
async function save() {
  if (anyBusy.value || !editable.value || stale.value || parentPreview.value || !workstreamReady.value || (workstreamOnly.value && !workstreamChanged.value)) return;
  error.value = ''; notice.value = '';
  if (!classificationOnly.value && !draft.title.trim()) { error.value = '请填写任务名称。'; return; }
  if (!workstreamOnly.value && !classificationOnly.value && draft.requiresReview && (!draft.reviewerId || !reviewerOptions.value.some(a => a.id === draft.reviewerId) || !draft.acceptanceCriteria.trim())) { error.value = '关键交付物需指定有权限的验收人并填写验收标准。'; return; }
  if (!props.task && (!!draft.start !== !!draft.end || (draft.start && draft.end && draft.start > draft.end))) { error.value = '请同时填写开始与结束日期，且结束日期不早于开始日期。'; return; }
  const payload = normalizedDraft();
  if (!props.task && payload.parentId) {
    const parent = selectedParent.value;
    if (!parent || !parent.parentEligibility || parent.parentEligibility.mode === 'blocked') { error.value = parent ? eligibilityReason(parent) : '请选择当前工作分组中的一级任务。'; return; }
    if (parent.parentEligibility.mode === 'convert') {
      busy.value = true;
      try {
        const result = await previewParent(props.workspace, props.actorId, { parentId: payload.parentId, workstreamId: payload.workstreamId, expectedPlanVersion: expectedPlanVersion.value });
        if (result.mode !== 'convert') { stale.value = true; error.value = '父任务类型已变化，请重新读取后核对。'; return; }
        parentPreview.value = result; previewDraft.value = payload; previewActor.value = props.actorId;
        nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.td-parent-preview'); panel?.scrollIntoView({ block: 'start' }); panel?.focus(); });
      } catch (e) { failed(e); } finally { busy.value = false; }
      return;
    }
  }
  await persistDraft(payload);
}
async function confirmConversion() {
  if (!parentPreview.value || !previewDraft.value || anyBusy.value || stale.value || previewActor.value !== props.actorId) return;
  await persistDraft(previewDraft.value, { confirmParentConversion: true, expectedParentVersion: parentPreview.value.expectedParentVersion }, parentPreview.value.expectedPlanVersion);
}
async function persistDraft(payload: TaskDraft, confirmation?: ParentConfirmation, planVersion = expectedPlanVersion.value) {
  const workspace = { ...props.workspace, planVersion, structureVersion: expectedStructureVersion.value };
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const workstreamPreviewToken = workstreamChanged.value ? workstreamPreview.value?.previewToken : undefined;
    const migrated = workstreamChanged.value;
    const key = keyFor(props.task ? 'update' : 'create', { ...payload, ...confirmation, workstreamPreviewToken, expectedVersion: expectedVersion.value, expectedPlanVersion: planVersion, expectedStructureVersion: expectedStructureVersion.value });
    const result = props.task ? await updateTask(workspace, props.actorId, props.task.id, payload, expectedVersion.value, key, workstreamPreviewToken) : await createTask(workspace, props.actorId, payload, key, confirmation);
    draftSnapshot.value = JSON.stringify(draft); editing.value = false; parentPreview.value = null; previewDraft.value = null;
    expectedVersion.value = result.task.version; expectedPlanVersion.value = result.planVersion;
    emit('saved', props.task ? migrated ? `任务修改已保存，已移至「${streamName(payload.workstreamId)}」。原分组筛选下将不再显示，计划与统计已同步。` : '任务修改已保存，计划和总览将同步更新。' : confirmation ? '已创建汇总父任务，原有工作与新任务已作为二级任务保存。' : '任务已创建，计划和总览已同步。', props.task ? undefined : result.task.id);
  } catch (e) { failed(e); } finally { busy.value = false; }
}
async function execute() {
  if (!props.task || !action.value || anyBusy.value || stale.value) return;
  if (!availableActions.value.includes(action.value)) { error.value = '当前身份或任务状态不允许此操作，请重新读取任务。'; return; }
  if (reasonPolicy.value === 'required' && !reason.value.trim()) { error.value = '此高危操作须填写原因或依据。'; return; }
  if (action.value === 'submit' && !actionEvidence.value.trim()) { error.value = '请填写成果说明或成果链接后提交验收。'; return; }
  if (!isContainer.value && ['progress', 'reopen'].includes(action.value) && (!Number.isInteger(Number(actionProgress.value)) || Number(actionProgress.value) < 0 || Number(actionProgress.value) > 99)) { error.value = '进度需为 0–99 之间的整数，完成状态请通过完成或验收操作更新。'; return; }
  const payload: TaskMutation = { expectedVersion: expectedVersion.value, expectedPlanVersion: expectedPlanVersion.value, expectedStructureVersion: expectedStructureVersion.value, action: action.value, reason: reason.value.trim(), ...(!isContainer.value && ['progress', 'reopen'].includes(action.value) ? { progress: Number(actionProgress.value) } : {}), ...(action.value === 'submit' ? { evidence: actionEvidence.value.trim() } : {}), ...(['accept', 'reject'].includes(action.value) ? { submissionId: latestSubmission.value?.id } : {}) };
  busy.value = true; error.value = ''; notice.value = '';
  try { const result = await mutateTask(props.workspace, props.actorId, props.task.id, payload, keyFor('transition', payload)); const message = `${actionNames[action.value]}已记录，计划与总览将同步更新。`; reason.value = ''; action.value = null; expectedVersion.value = result.task.version; expectedPlanVersion.value = result.planVersion; actionEvidence.value = result.task.evidence; initialEvidence.value = actionEvidence.value; actionProgress.value = result.task.status === 'done' ? 0 : Math.min(99, result.task.progress); initialProgress.value = actionProgress.value; emit('saved', message); }
  catch (e) { failed(e); } finally { busy.value = false; }
}
async function addComment() {
  if (!props.task || !comment.value.trim() || !writable.value || anyBusy.value || stale.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const payload = { text: comment.value.trim(), expectedVersion: expectedVersion.value, expectedPlanVersion: expectedPlanVersion.value, expectedStructureVersion: expectedStructureVersion.value };
  try {
    const result = await commentTask({ ...props.workspace, planVersion: expectedPlanVersion.value, structureVersion: expectedStructureVersion.value }, props.actorId, props.task.id, payload.text, expectedVersion.value, keyFor('comment', payload));
    expectedVersion.value = result.task.version; expectedPlanVersion.value = result.planVersion; comment.value = ''; notice.value = '评论已保存到本机活动记录。'; emit('reload');
  } catch (e) { failed(e); } finally { busy.value = false; }
}
function tabKeys(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault(); const index = tabs.value.findIndex(t => t.id === tab.value);
  tab.value = tabs.value[event.key === 'Home' ? 0 : event.key === 'End' ? tabs.value.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.value.length) % tabs.value.length]!.id;
  nextTick(() => dialog.value?.querySelector<HTMLButtonElement>(`#td-tab-${tab.value}`)?.focus());
}
async function requestDelete() { if(props.task && await confirmNavigation()) emit('deleteTask',props.task); }
defineExpose({ confirmNavigation, isDirty: dirty, isBusy: anyBusy });
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { window.removeEventListener('beforeunload', beforeUnload); settleNavigation(false); dialog.value?.close(); });
</script>

<template>
  <dialog ref="dialog" class="task-drawer" aria-labelledby="td-title" :aria-busy="anyBusy" @close="emit('close')" @cancel.prevent="leave()">
    <div class="td-shell">
      <header class="td-header">
        <div class="td-header-row"><span class="td-reference"><Icon name="task" :size="16"/>{{ task ? `WBS ${task.wbs}` : '新建任务' }}</span><div class="recycle-inline-actions"><details v-if="task?.canDelete && !editing" class="task-more"><summary aria-label="任务更多操作">···</summary><div class="task-more-menu"><button :disabled="anyBusy" @click="requestDelete(); ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">删除任务</button></div></details><button type="button" class="td-icon-button" aria-label="关闭任务详情" :disabled="anyBusy" @click="leave()"><Icon name="close"/></button></div></div>
        <button v-if="backTaskLabel" class="td-text-button" :disabled="anyBusy" @click="leave(() => emit('backTask'))">‹ 返回 {{ backTaskLabel }}</button>
        <h2 id="td-title">{{ task?.title || '把下一步工作安排清楚' }}</h2>
        <p class="td-stream">{{ task ? streamName(task.workstreamId) : workspace.project.name }}</p>
        <div v-if="task" class="td-badges"><span class="td-state" :class="`td-state-${task.status}`">{{ stateName(task) }}</span><span class="td-priority">{{ task.priority }}</span><span v-if="isContainer" class="td-priority">汇总任务</span><span v-if="task.originalWork" class="td-review-label">原有工作</span><span v-if="task.requiresReview" class="td-review-label"><Icon name="flag" :size="13"/>关键交付物</span><span v-if="task.blocked" class="td-block-label">阻塞中</span></div>
      </header>
      <div v-if="workspace.project.isDemo" class="td-demo"><span class="demo-label">DEMO</span><span>本机示例 · 当前身份 {{ actor?.name ?? '未知身份' }}</span></div>
      <div v-if="task" class="td-tabs" role="tablist" aria-label="任务详情栏目" @keydown="tabKeys"><button v-for="item in tabs" :id="`td-tab-${item.id}`" :key="item.id" role="tab" :aria-selected="tab === item.id" :aria-controls="`td-panel-${item.id}`" :tabindex="tab === item.id ? 0 : -1" @click="tab = item.id">{{ item.name }}<span v-if="item.id === 'children' && children.length">{{ children.length }}</span></button></div>
      <div class="td-body">
        <section v-if="confirmLeave" class="td-leave-panel" role="alert" aria-labelledby="td-leave-title"><h3 id="td-leave-title">还有未保存的内容</h3><p>继续编辑可保留当前填写内容；放弃后将离开当前操作。</p><div class="td-inline-buttons"><button class="button primary" @click="keepEditing">保留并继续编辑</button><button class="button" @click="discard">放弃未保存内容</button></div></section>
        <div v-if="error" class="td-error" role="alert"><p>{{ error }}</p><button v-if="stale" class="td-text-button" :disabled="anyBusy" @click="reload">重新读取任务（保留填写内容）</button></div>
        <p v-if="notice" class="td-notice" role="status">{{ notice }}</p>
        <section v-show="tab === 'detail' || !task" id="td-panel-detail" :role="task ? 'tabpanel' : undefined" :aria-labelledby="task ? 'td-tab-detail' : undefined">
          <div v-if="!writable" class="td-callout"><Icon name="info" :size="17"/><p>当前为只读身份，可以查看任务、成果与操作记录。</p></div>
          <form v-if="editing" id="td-edit-form" class="td-form" :novalidate="classificationOnly" @submit.prevent="save">
            <fieldset :disabled="anyBusy || !editable || !!parentPreview">
              <label class="td-field">任务名称 <span class="td-required">*</span><input v-model="draft.title" required maxlength="160" :readonly="!canEditCommitment" placeholder="例如：完成数据接口联调"/></label>
              <div class="td-form-grid"><label class="td-field">所属工作分组<select aria-label="所属工作分组" v-model="draft.workstreamId" :disabled="task ? !canChangeWorkstream : !canEditCommitment" required><option v-for="stream in selectableStreams" :key="stream.id" :value="stream.id" :disabled="stream.active === false && stream.id !== task?.workstreamId">{{ stream.name }}{{ stream.active === false ? '（已停用）' : '' }}</option></select></label><label class="td-field">优先级<select aria-label="优先级" v-model="draft.priority" :disabled="!canEditCommitment"><option>P0</option><option>P1</option><option>P2</option></select></label></div>
              <p v-if="workstreamOnly" class="td-field-note">当前任务仅可调整工作分组，其他内容与验收状态保持锁定。</p>
              <p v-if="task?.parentId" class="td-field-note">工作分组跟随父任务，请在父任务中修改。<button type="button" class="td-text-button" @click="leave(() => emit('openTask', task!.parentId!))">查看父任务</button></p>
              <p v-else-if="task && !canChangeWorkstream" class="td-field-note">仅本项目负责人或项目管理员可以调整工作分组。</p>
              <section v-if="workstreamChanged" class="td-workstream-impact" aria-label="分组调整范围" aria-live="polite" :aria-busy="workstreamChecking">
                <p v-if="workstreamChecking" class="td-field-note">正在读取分组调整范围…</p>
                <template v-else-if="workstreamPreview">
                  <strong>{{ streamName(workstreamPreview.sourceWorkstreamId) }} → {{ streamName(workstreamPreview.workstreamId) }}</strong>
                  <p>{{ isContainer ? `将同步调整父任务及其 ${workstreamPreview.tasks.length - 1} 个子任务。` : '将调整当前独立任务的工作分组。' }}</p>
                  <ul v-if="isContainer"><li v-for="affected in workstreamPreview.tasks.filter(t => t.id !== task?.id)" :key="affected.id"><span>{{ affected.title }}</span><small>{{ stateName(affected) }}</small></li></ul>
                  <p class="td-field-note">任务状态、排期、依赖和验收结果保留，点击「保存修改」后生效。</p>
                </template>
                <p v-if="workstreamError" class="td-warning-text" role="alert">{{ workstreamError }} <button type="button" class="td-text-button" @click="checkWorkstream">重新读取调整范围</button></p>
              </section>
              <p v-if="selectedStreamInactive" class="td-field-note">此工作分组已停用，已有任务可以继续处理；不能再新增子任务。</p><p v-if="!task && !selectableStreams.length" class="td-warning-text">没有启用的工作分组，请先在工作分组管理中新增或启用分组。</p><button v-if="!task && manager" type="button" class="td-text-button" @click="leave(() => emit('manageWorkstreams'))">管理工作分组</button>
              <template v-if="!task">
                <label class="td-field">搜索父任务<input v-model="parentSearch" type="search" aria-label="搜索父任务" aria-describedby="td-parent-search-help" placeholder="按任务名称或 WBS 搜索"/><small id="td-parent-search-help">{{ manager ? '仅展示当前工作分组的一级任务，工作分组不计入任务层级。' : '仅可在已有汇总任务下创建二级任务；执行任务转换需联系项目负责人或管理员。' }}</small></label>
                <label class="td-field">父任务（可选）<select v-model="draft.parentId" aria-label="父任务（可选）"><option :value="null">独立任务</option><option v-for="parent in filteredParents" :key="parent.id" :value="parent.id" :disabled="!parent.parentEligibility || parent.parentEligibility.mode === 'blocked'">{{ parent.wbs }} · {{ parent.title }} · {{ eligibilityReason(parent) }}</option></select><small v-if="selectedParent">{{ eligibilityReason(selectedParent) }}</small><small v-else-if="!filteredParents.length">没有匹配的一级任务，可调整搜索或创建独立任务。</small><small v-else>{{ manager ? '选择执行任务后先预览转换，确认后保留原有工作并创建二级任务。' : '二级任务不再作为父任务。' }}</small></label>
              </template>
              <div class="td-form-grid"><label class="td-field">负责人<select aria-label="负责人" v-model="draft.ownerId" required :disabled="!canEditCommitment"><option v-for="person in ownerOptions" :key="person.id" :value="person.id" :disabled="person.role === 'viewer'">{{ person.name }}{{ person.role === 'viewer' ? '（历史负责人，只读）' : '' }}</option></select></label><label class="td-field">预计工时（小时）<input v-model="draft.effortHours" type="number" min="0.5" max="10000" step="0.5" :readonly="!canEditCommitment" placeholder="暂未估算"/></label></div>
              <div v-if="!task" class="td-form-grid"><label class="td-field">计划开始<input v-model="draft.start" type="date" :min="workspace.project.start" :max="workspace.project.end"/></label><label class="td-field">计划结束<input v-model="draft.end" type="date" :min="draft.start || workspace.project.start" :max="workspace.project.end"/></label></div>
              <p v-else class="td-field-note">现有计划日期请在「计划与依赖」中修改，两个栏目分别保存。</p>
              <label class="td-field">任务描述<textarea v-model="draft.description" :readonly="workstreamOnly" rows="4" maxlength="5000" placeholder="说明工作范围、输出与协作注意事项"></textarea></label>
              <label class="td-check"><input v-model="draft.requiresReview" type="checkbox" :disabled="!canEditCommitment"/><span>作为关键交付物，需要验收</span></label>
              <label v-if="draft.requiresReview" class="td-field">指定验收人<select v-model="draft.reviewerId" required :disabled="!canEditCommitment"><option :value="null" disabled>选择验收人（成员不可自验）</option><option v-for="person in reviewerOptions" :key="person.id" :value="person.id">{{ person.name }}</option></select></label>
              <label class="td-field">验收标准<textarea v-model="draft.acceptanceCriteria" rows="3" maxlength="5000" :required="draft.requiresReview" :readonly="!canEditCommitment" placeholder="完成后需要满足哪些条件"></textarea></label>
              <label class="td-field">成果说明与链接<textarea v-model="draft.evidence" :readonly="workstreamOnly" rows="3" maxlength="5000" placeholder="填写成果说明，或粘贴 http(s) 链接"></textarea></label>
              <p v-if="!manager && task" class="td-field-note">任务负责人可维护描述与成果；任务承诺由项目负责人或管理员管理。</p>
            </fieldset>
          </form>
          <section v-if="parentPreview && previewDraft" class="td-parent-preview td-action-panel" aria-labelledby="td-parent-preview-title" tabindex="-1">
            <h3 id="td-parent-preview-title">转为汇总父任务</h3>
            <p class="td-prose">当前为只读预览，尚未保存。确认后在「{{ streamName(previewDraft.workstreamId) }}」创建以下两级结构：</p>
            <ul class="td-preview-tree"><li><strong>{{ parentPreview.parent.title }}</strong><span class="td-priority">新增汇总父任务</span><ul><li><strong>{{ parentPreview.parent.title }}</strong><span class="td-review-label">原有工作</span><small>原任务编号：{{ parentPreview.parent.wbs }} · 历史记录保留</small><small>{{ parentPreview.parent.owner }} · {{ stateName(parentPreview.parent) }} · {{ parentPreview.parent.progress }}% · {{ parentPreview.parent.effortHours === null ? '工时未估算' : `${parentPreview.parent.effortHours} 小时` }}</small><small>{{ parentPreview.parent.start || '待排期' }} → {{ parentPreview.parent.end || '待排期' }}</small></li><li><strong>{{ previewDraft.title }}</strong><span class="td-priority">新增二级任务</span><small>负责人：{{ actorName(previewDraft.ownerId) }}</small></li></ul></li></ul>
            <p class="td-field-note">{{ parentPreview.retained.map(item => item === '原任务 ID 与编号' ? '原任务和编号' : item).join('、') }}将保留，原依赖和基线继续引用原执行任务。执行任务数量增加 {{ parentPreview.executionCountDelta }} 项，汇总父任务不计入执行分母。</p>
            <p class="td-field-note">当前表单已锁定；返回编辑会保留草稿，并在下次创建时重新预览。确认后将保存任务，并留下活动记录。</p>
          </section>
          <template v-if="!editing && task">
            <button v-if="task.parentId" class="td-related-task td-parent-context" @click="leave(() => emit('openTask', task!.parentId!))"><span><small>所属父任务 · {{ hierarchyLabel }}</small><strong>{{ parentTask?.title || task.parentId }}</strong></span><Icon name="chevron" :size="16"/></button>
            <div class="td-section-heading"><h3>基本信息</h3><button v-if="editable" class="td-text-button" @click="startEdit"><Icon name="settings" :size="14"/>编辑任务</button></div>
            <p class="td-field-note">创建者：{{ task.creatorName || '历史任务，创建者未记录' }}</p><dl class="td-facts"><div><dt>负责人</dt><dd><span class="td-avatar">{{ task.owner.slice(0, 1) }}</span>{{ task.owner }}</dd></div><div><dt>预计工时</dt><dd>{{ task.effortHours === null ? '暂未估算' : `${task.effortHours} 小时` }}</dd></div><div class="td-fact-wide"><dt>计划日期</dt><dd><span>{{ task.start && task.end ? `${task.start} → ${task.end}` : '待排期' }}</span><button class="td-text-button" @click="showInlinePlan">查看计划与依赖<Icon name="arrow" :size="14"/></button></dd></div><div><dt>实际开始</dt><dd>{{ task.actualStart || (task.status === 'todo' ? '尚未开始' : '未记录（原始数据无实际日期）') }}</dd></div><div><dt>实际完成</dt><dd>{{ task.actualEnd || (task.status === 'done' ? '未记录（原始数据无实际日期）' : '尚未完成') }}</dd></div></dl>
            <button class="td-text-button" @click="showMilestones">查看关联里程碑 ↗</button><div class="td-progress"><div><span>{{ isContainer ? '子任务汇总进度' : '执行进度' }}</span><strong>{{ task.progress }}%</strong></div><progress :value="task.progress" max="100">{{ task.progress }}%</progress></div>
            <div v-if="task.blocked" class="td-callout td-warning"><Icon name="info" :size="18"/><div><strong>当前任务存在阻塞</strong><p>{{ task.blockReason || '未填写阻塞说明' }}</p></div></div>
            <section class="td-section"><h3>任务描述</h3><p class="td-prose">{{ task.description || '尚未填写描述，可通过编辑任务补充工作范围。' }}</p></section>
            <section v-if="!isContainer" class="td-section"><div class="td-section-heading"><h3>成果与验收</h3><span v-if="task.requiresReview" class="td-subtle">{{ reviewName(task.reviewStatus) }}</span></div><dl v-if="task.requiresReview" class="td-facts"><div class="td-fact-wide"><dt>验收人</dt><dd>{{ actorName(task.reviewerId) }}</dd></div></dl><h4>验收标准</h4><p class="td-prose">{{ task.acceptanceCriteria || '尚未填写验收标准。' }}</p><h4>成果说明与链接</h4><p class="td-prose">{{ task.evidence || '暂无成果记录，负责人可补充说明与链接。' }}</p><a v-for="url in evidenceLinks(task.evidence)" :key="url" class="td-evidence-link" :href="url" target="_blank" rel="noopener noreferrer"><Icon name="arrow" :size="14"/>{{ url }}</a><p v-if="task.requiresReview" class="td-field-note">指定成员可通过或退回；项目负责人和管理员可处理全部验收，自验需说明原因并留痕。</p></section>
            <section class="td-section"><h3>前置依赖 <span class="td-subtle">{{ predecessors.length }} 项</span></h3><div v-if="!predecessors.length" class="td-empty-inline">没有前置依赖，可在「计划与依赖」中设置。</div><button v-for="dependency in predecessors" :key="dependency.predecessorId" class="td-related-task" @click="leave(() => dependency.task ? emit('openTask', dependency.predecessorId) : emit('showPlan', dependency.predecessorId))"><span><strong>{{ dependency.task?.title || dependency.predecessorId }}</strong><small>{{ dependency.task ? stateName(dependency.task) : '计划范围项' }} · 完成后开始{{ dependency.lagDays ? ` · 间隔 ${dependency.lagDays} 天` : '' }}</small><small v-if="dependency.task && dependency.task.status !== 'done'" class="td-warning-text">前置尚未完成，请先核对执行条件</small></span><Icon name="chevron" :size="16"/></button></section>
            <p v-if="task.reviewStatus === 'submitted'" class="td-field-note">成果已提交验收，当前内容已锁定。可在活动记录补充说明，需修改时由指定验收人退回。</p><p v-if="isContainer" class="td-field-note">汇总任务不独立执行或验收，由未取消子任务汇总。请进入子任务更新执行状态；取消的汇总任务需由项目负责人先恢复。</p>
            <p v-else-if="['done', 'cancelled'].includes(task.status)" class="td-field-note">{{ task.status === 'done' ? '已完成任务保留原记录，修改执行内容前需说明原因并重开；管理人员可直接调整工作分组。' : '已取消任务保留历史，可说明原因后重开；管理人员可直接调整工作分组。' }}</p>
          </template>
        </section>
        <section v-if="task && planActivated" v-show="tab === 'plan'" id="td-panel-plan" role="tabpanel" aria-labelledby="td-tab-plan"><TaskPlanPanel ref="planPanel" :task="task" :project-id="workspace.project.id" :actor-id="actorId" :plan-version="workspace.planVersion" :initial-editing="initialPlanEditing" :proposal="planProposal" :disabled="busy" @saved="emit('planSaved')" @open-task="id => leave(() => emit('openTask', id))" @open-milestone="openMilestone"/></section>
        <section v-if="task" v-show="tab === 'children'" id="td-panel-children" role="tabpanel" aria-labelledby="td-tab-children"><div class="td-section-heading"><h3>子任务</h3><span class="td-subtle">{{ children.length }} 项</span></div><button v-for="child in children" :key="child.id" class="td-related-task" @click="leave(() => emit('openTask', child.id))"><span><small>WBS {{ child.wbs }}</small><strong>{{ child.title }}<span v-if="child.originalWork" class="td-review-label">原有工作</span></strong><small>{{ child.owner }} · {{ stateName(child) }} · {{ child.progress }}%</small></span><Icon name="chevron" :size="16"/></button><div v-if="!children.length" class="td-empty"><Icon name="layers" :size="32"/><h3>暂无子任务</h3><p>{{ task.parentId ? '二级任务直接执行，不再添加第三层任务。' : isContainer ? '汇总任务保留汇总类型，不独立执行。项目负责人可在新建任务中选择此任务作为父任务。' : eligibilityReason(task) }}</p></div></section>
        <section v-if="task" v-show="tab === 'activity'" id="td-panel-activity" role="tabpanel" aria-labelledby="td-tab-activity">
          <form v-if="writable" class="td-comment" @submit.prevent="addComment"><label class="td-field">补充进展<textarea v-model="comment" rows="3" required maxlength="3000" :disabled="anyBusy" placeholder="记录进展或需要协助的事项"></textarea></label><div><span class="td-field-note">保存到当前任务记录</span><button class="button primary" :disabled="anyBusy || stale || !comment.trim()">{{ anyBusy ? '正在保存…' : '保存评论' }}</button></div></form>
          <div class="td-section-heading"><h3>活动记录</h3><span class="td-subtle">{{ task.events.length }} 条</span></div><article v-for="event in [...task.events].reverse()" :key="event.id" class="td-event"><span class="td-avatar">{{ event.actor.slice(0, 1) }}</span><div><h4>{{ event.actor }}<span>{{ actionNames[event.action as TaskAction] || ({ create: '创建任务', update: '编辑任务', workstream_change: '调整工作分组', comment: '评论', batch: '批量更新' }[event.action] || event.action) }}</span></h4><p class="td-prose">{{ event.text }}</p><time>{{ dateTime(event.createdAt) }}</time></div></article><div v-if="!task.events.length" class="td-empty-inline">暂无活动，后续任务操作与评论会显示在这里。</div>
          <section v-if="task.submissions.length" class="td-section"><h3>验收记录</h3><article v-for="submission in [...task.submissions].reverse()" :key="submission.id" class="td-submission"><div class="td-section-heading"><strong>第 {{ submission.version }} 版</strong><span>{{ reviewName(submission.status) }}</span></div><p class="td-subtle">{{ actorName(submission.submitterId) }} → 指定验收：{{ actorName(submission.reviewerId) }}</p><p v-if="submission.reviewedById" class="td-field-note">实际验收：{{ actorName(submission.reviewedById) }}{{ submission.selfReview ? ' · 管理员自验' : '' }}</p><template v-if="submission.snapshot"><h4>提交时的任务</h4><p class="td-prose">{{ submission.snapshot.title }}</p><p class="td-field-note">提交时负责人：{{ actorName(submission.snapshot.ownerId) }}</p><h4>提交时的验收标准</h4><p class="td-prose">{{ submission.snapshot.acceptanceCriteria || '该版本未填写验收标准。' }}</p><h4>提交时的任务描述</h4><p class="td-prose">{{ submission.snapshot.description || '该版本未填写任务描述。' }}</p></template><p v-else class="td-field-note">此历史版本未保留任务与验收标准快照。</p><h4>本版成果</h4><p class="td-prose">{{ submission.evidence }}</p><p v-if="submission.comment" class="td-prose">验收意见：{{ submission.comment }}</p><time>{{ dateTime(submission.reviewedAt || submission.createdAt) }}</time></article></section>
        </section>
        <section v-if="task && action && !editing && tab === 'detail'" class="td-action-panel" aria-labelledby="td-action-title" tabindex="-1">
          <div class="td-section-heading"><h3 id="td-action-title">{{ actionNames[action] }}</h3><button class="td-icon-button" aria-label="收起操作确认" :disabled="anyBusy" @click="closeAction"><Icon name="close" :size="16"/></button></div>
          <p v-if="selfReview" class="td-warning-text" role="note">你正在验收自己负责或提交的成果。请填写自验理由，确认后记录实际操作者和自验身份。</p><p class="td-prose">将由 {{ actor?.name }} 对「{{ task.title }}」执行{{ actionNames[action] }}，结果同步到计划、总览与活动记录。</p>
          <p v-if="action === 'reopen' && isContainer" class="td-field-note">恢复后继续按未取消子任务汇总，不修改子任务执行进度。</p><p v-else-if="action === 'reopen'" class="td-warning-text">重开会清除本次完成日期；已验收的关联后续成果将进入复核，原验收历史仍保留。</p>
          <p v-if="action === 'cancel'" class="td-warning-text">取消后保留历史与依赖记录，不计入已完成任务。</p>
          <p v-if="!availableActions.includes(action)" class="td-warning-text">当前身份或状态不支持此操作，请收起确认后查看最新任务。</p>
          <form id="td-action-form" @submit.prevent="execute"><label v-if="!isContainer && (action === 'progress' || action === 'reopen')" class="td-field">{{ action === 'reopen' ? '重开后的进度（%）' : '当前进度（%）' }}<input v-model="actionProgress" type="number" min="0" max="99" step="1" required :disabled="anyBusy"/></label><label v-if="action === 'submit'" class="td-field">成果说明与链接<textarea v-model="actionEvidence" rows="3" maxlength="5000" required :disabled="anyBusy"></textarea></label><div v-if="['accept', 'reject'].includes(action) && latestSubmission" class="td-review-evidence"><h4>本次提交 · 第 {{ latestSubmission.version }} 版</h4><template v-if="latestSubmission.snapshot"><p class="td-prose">{{ latestSubmission.snapshot.title }}</p><h4>提交时的验收标准</h4><p class="td-prose">{{ latestSubmission.snapshot.acceptanceCriteria || '该版本未填写验收标准。' }}</p></template><h4>本版成果</h4><p class="td-prose">{{ latestSubmission.evidence }}</p><span class="td-field-note">提交人 {{ actorName(latestSubmission.submitterId) }}</span></div><label v-if="reasonPolicy !== 'hidden'" class="td-field">{{ selfReview ? '自验依据' : action === 'reject' ? '验收意见' : action === 'block' ? '阻塞说明' : action === 'unblock' ? '解除阻塞说明' : '操作说明' }}{{ reasonPolicy === 'optional' ? '（选填）' : '' }} <span v-if="reasonPolicy === 'required'" class="td-required">*</span><textarea v-model="reason" rows="3" maxlength="1000" :required="reasonPolicy === 'required'" :disabled="anyBusy" :placeholder="action === 'block' ? '说明当前阻塞原因与需要的协助' : '说明本次操作的依据，保存后将留下记录'"></textarea></label></form>
        </section>
      </div>
      <footer class="td-footer">
        <template v-if="task && tab === 'plan'"><button v-if="planPanel?.secondaryLabel" class="button" :disabled="anyBusy" @click="planPanel?.secondary()">{{ planPanel?.secondaryLabel }}</button><button v-else class="button" :disabled="anyBusy" @click="leave()">关闭</button><button v-if="planPanel?.primaryLabel" class="button primary" :disabled="planPanel?.primaryDisabled || anyBusy" @click="planPanel?.primary()">{{ anyBusy ? '正在处理…' : planPanel?.primaryLabel }}</button></template>
        <template v-else-if="task && tab !== 'detail'"><span class="td-field-note">{{ tab === 'activity' ? '评论单独保存到活动记录' : '选择子任务查看详情' }}</span><button class="button" :disabled="anyBusy" @click="leave()">关闭</button></template>
        <template v-else-if="parentPreview"><button class="button" :disabled="anyBusy" @click="returnToEdit">返回编辑</button><button class="button primary" :disabled="anyBusy || stale || !editable" @click="confirmConversion">{{ anyBusy ? '正在保存…' : '确认转换并创建' }}</button></template>
        <template v-else-if="editing"><button class="button" :disabled="anyBusy" @click="task ? cancelEdit() : leave()">取消</button><button class="button primary" form="td-edit-form" :disabled="anyBusy || stale || !editable || !workstreamReady || (workstreamOnly && !workstreamChanged) || (!task && !draft.workstreamId)">{{ anyBusy ? (selectedParent?.parentEligibility?.mode === 'convert' ? '正在预览…' : '正在保存…') : task ? '保存修改' : selectedParent?.parentEligibility?.mode === 'convert' ? '预览转换并创建' : '创建任务' }}</button></template>
        <template v-else-if="action"><button class="button" :disabled="anyBusy" @click="closeAction">返回详情</button><button class="button primary" form="td-action-form" :disabled="anyBusy || stale || !availableActions.includes(action)">{{ anyBusy ? '正在保存…' : confirmNames[action] }}</button></template>
        <template v-else><span v-if="!availableActions.length" class="td-field-note">{{ editable ? '可在详情中编辑任务' : writable ? '当前任务仅可查看' : '只读访问' }}</span><div class="td-secondary-actions"><button v-for="option in availableActions.slice(1)" :key="option" class="td-text-button" :disabled="anyBusy" @click="stage(option)">{{ actionNames[option] }}</button></div><button v-if="availableActions[0]" class="button primary" :disabled="anyBusy" @click="stage(availableActions[0])">{{ actionNames[availableActions[0]] }}</button><button v-else class="button" @click="leave()">关闭</button></template>
      </footer>
    </div>
  </dialog>
</template>
