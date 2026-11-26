<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { applyPlan, fetchPlan, previewPlan, PlanningError } from '../../api/planning';
import { calendarDescription } from '../../utils/project-presentation';
import type { ManagedTask } from '../../../../shared/src/tasks';
import type { ProjectPlan, PlanPreview } from '../../../../shared/src/planning';

const props = defineProps<{ task: ManagedTask; projectId: string; actorId: string; planVersion: number; initialEditing?: boolean; proposal?: { start: string; end: string }; disabled?: boolean }>();
const emit = defineEmits<{ saved: []; openTask: [id: string]; openMilestone: [id: string] }>();
const plan = ref<ProjectPlan>();
const root = ref<HTMLElement>();
async function showTop() { await nextTick(); const body = root.value?.closest('.td-body'); if (body) body.scrollTop = 0; }
const loading = ref(false), busy = ref(false), error = ref(''), notice = ref(''), stale = ref(false);
const editing = ref(false), preview = ref<PlanPreview | null>(null), search = ref('');
const start = ref(''), end = ref(''), mode = ref<'push_successors' | 'earliest_start'>('push_successors');
const calculation = ref<'schedule' | 'relationships_only'>('schedule');
const edges = ref<Array<{ predecessorId: string; lagDays: number }>>([]);
const supplementary = ref<Record<string, { start: string; end: string }>>({});
const confirmDiscard = ref<'cancel' | 'dates' | null>(null);
let idempotencyKey = '', pendingEdit = !!props.initialEditing, initialized = false;
const snapshot = ref('');
const state = () => JSON.stringify({ start: start.value, end: end.value, mode: mode.value, calculation: calculation.value, edges: edges.value, supplementary: supplementaryEdits.value });
const isDirty = computed(() => editing.value && state() !== snapshot.value);
const isBusy = computed(() => busy.value || loading.value);
const node = computed(() => plan.value?.nodes.find(n => n.id === props.task.id));
const lockReason = computed(() => {
  if (!plan.value?.canEditSchedule) return '仅本项目负责人或项目管理员可调整计划与依赖；系统管理员身份不自动授予此权限。';
  if (props.task.taskKind === 'summary' || props.task.isContainer) return '汇总任务的日期、工时和进度由子任务汇总，请进入子任务调整。';
  if (props.task.status === 'done') return '已完成任务的日期与前置依赖已锁定，需先重开任务。';
  if (props.task.status === 'cancelled') return '已取消任务不能调整计划，请先恢复任务。';
  if (props.task.reviewStatus === 'submitted') return '任务正在验收，需先退回修改。';
  if (!node.value) return '当前任务已不在有效计划中，请重新读取任务。';
  return '';
});
const canEdit = computed(() => !!plan.value && !lockReason.value);
const incoming = computed(() => plan.value?.dependencies.filter(d => d.successorId === props.task.id) ?? []);
const outgoing = computed(() => plan.value?.dependencies.filter(d => d.predecessorId === props.task.id) ?? []);
const label = (id: string) => { const n = plan.value?.nodes.find(n => n.id === id); return n ? `${n.wbs} · ${n.title}` : '关联对象不可用'; };
function openRelated(id: string) { const n = plan.value?.nodes.find(n => n.id === id); if (n?.kind === 'milestone') emit('openMilestone', id); else if (n?.kind === 'task' || n?.taskKind === 'summary') emit('openTask', id); }
const candidates = computed(() => plan.value?.nodes.filter(n => ['task', 'milestone'].includes(n.kind) && n.id !== props.task.id && n.taskKind !== 'summary' && n.milestoneState !== 'cancelled') ?? []);
function options(selected: string) { const q = search.value.trim().toLowerCase(); return candidates.value.filter(n => n.id === selected || ((!q || `${n.wbs} ${n.title}`.toLowerCase().includes(q)) && !edges.value.some(e => e.predecessorId === n.id))); }
const connectedNodes = computed(() => {
  if (!plan.value) return [];
  const dependencies = [...plan.value.dependencies.filter(d => d.successorId !== props.task.id), ...edges.value.map(e => ({ ...e, successorId: props.task.id }))];
  const ids = new Set([props.task.id]);
  let changed = true;
  while (changed) { changed = false; for (const d of dependencies) if (ids.has(d.predecessorId) || ids.has(d.successorId)) { const before = ids.size; ids.add(d.predecessorId); ids.add(d.successorId); changed ||= ids.size !== before; } }
  return plan.value.nodes.filter(n => ids.has(n.id) && ['task', 'milestone'].includes(n.kind));
});
const supplementaryNodes = computed(() => connectedNodes.value.filter(n => n.id !== props.task.id && (!(n.start && n.end) || n.durationDays === null)));
watch(supplementaryNodes, nodes => { for (const n of nodes) supplementary.value[n.id] ??= { start: n.start ?? '', end: n.end ?? '' }; }, { immediate: true });
const supplementaryEdits = computed(() => supplementaryNodes.value.flatMap(n => {
  const dates = supplementary.value[n.id];
  return dates && (dates.start !== (n.start ?? '') || dates.end !== (n.end ?? '')) ? [{ taskId: n.id, ...dates }] : [];
}));
const connectedMissing = computed(() => connectedNodes.value.filter(n => {
  if (n.id === props.task.id) return !(start.value && end.value);
  const dates = calculation.value === 'schedule' ? supplementary.value[n.id] : undefined;
  return dates ? !(dates.start && (n.kind === 'milestone' || dates.end)) : !(n.start && n.end) || n.durationDays === null;
}));
const dependencyDiff = computed(() => {
  if (!preview.value) return [];
  const after = preview.value.dependencies.filter(d => d.successorId === props.task.id);
  return [
    ...incoming.value.filter(d => !after.some(e => e.predecessorId === d.predecessorId)).map(d => `移除：${label(d.predecessorId)} · FS · ${d.lagDays} 工作日`),
    ...after.flatMap(d => { const old = incoming.value.find(e => e.predecessorId === d.predecessorId); return !old ? [`新增：${label(d.predecessorId)} · FS · ${d.lagDays} 工作日`] : old.lagDays !== d.lagDays ? [`修改间隔：${label(d.predecessorId)} · ${old.lagDays} → ${d.lagDays} 工作日`] : []; }),
  ];
});
const relevantIssues = computed(() => {
  const ids = new Set([...connectedNodes.value.map(n => n.id), ...(preview.value?.changes.map(c => c.taskId) ?? []), ...(preview.value?.affectedMilestoneIds ?? [])]);
  return preview.value?.issues.filter(i => i.severity === 'error' || ids.has(i.objectId)) ?? [];
});
const otherIssues = computed(() => preview.value?.issues.filter(i => !relevantIssues.value.includes(i)) ?? []);
function reset() {
  supplementary.value = {};
  start.value = node.value?.start ?? ''; end.value = node.value?.end ?? '';
  edges.value = incoming.value.map(d => ({ predecessorId: d.predecessorId, lagDays: d.lagDays }));
  mode.value = 'push_successors'; calculation.value = connectedMissing.value.length ? 'relationships_only' : 'schedule';
  preview.value = null; stale.value = false; error.value = ''; confirmDiscard.value = null; snapshot.value = state();
}
async function load(preserve = false) {
  if (loading.value) return;
  loading.value = true; error.value = '';
  try {
    plan.value = await fetchPlan(props.projectId, props.actorId);
    if (!preserve) reset(); else { preview.value = null; stale.value = false; notice.value = '已读取最新计划，填写内容仍保留，请核对后重新预览。'; }
    if (!initialized) {
      initialized = true;
      if (props.proposal && canEdit.value) { calculation.value = 'schedule'; start.value = props.proposal.start; end.value = props.proposal.end; editing.value = true; }
      if (pendingEdit && canEdit.value) editing.value = true;
      pendingEdit = false;
    }
  } catch (e) { fail(e); } finally { loading.value = false; }
}
function beginEdit() { if (!plan.value) { pendingEdit = true; return; } if (canEdit.value && !isBusy.value) { editing.value = true; notice.value = ''; } }
function fail(e: unknown) { error.value = e instanceof Error ? e.message : '暂时无法读取计划，请重试。'; stale.value = e instanceof PlanningError && [403, 409, 410].includes(e.status); }
function switchCalculation(event: Event) {
  const select = event.target as HTMLSelectElement;
  if (select.value === 'relationships_only' && (start.value !== (node.value?.start ?? '') || end.value !== (node.value?.end ?? '') || supplementaryEdits.value.length)) { select.value = calculation.value; confirmDiscard.value = 'dates'; return; }
  calculation.value = select.value as typeof calculation.value;
}
function discardConfirmed() {
  if (confirmDiscard.value === 'dates') { start.value = node.value?.start ?? ''; end.value = node.value?.end ?? ''; for (const n of supplementaryNodes.value) supplementary.value[n.id] = { start: n.start ?? '', end: n.end ?? '' }; calculation.value = 'relationships_only'; }
  else { reset(); editing.value = false; }
  confirmDiscard.value = null;
}
async function prepare() {
  if (!plan.value || !canEdit.value || isBusy.value || props.disabled) return;
  error.value = ''; notice.value = '';
  if (edges.value.some(e => !e.predecessorId || !Number.isInteger(e.lagDays) || e.lagDays < 0 || e.lagDays > 260)) { error.value = '请选择前置对象，间隔须为 0–260 个工作日的整数。'; return; }
  if (new Set(edges.value.map(e => e.predecessorId)).size !== edges.value.length) { error.value = '同一前置对象不能重复添加。'; return; }
  if (calculation.value === 'schedule' && connectedMissing.value.length) { error.value = '依赖链仍有未排期任务。可切换为仅保存依赖；补齐日期后再显式预览排期。'; return; }
  if (calculation.value === 'schedule' && (!start.value || !end.value || end.value < start.value)) { error.value = '请填写完整日期，结束日期不能早于开始日期。'; return; }
  const changes = calculation.value === 'relationships_only' ? [] : [{ taskId: props.task.id, start: start.value, end: end.value }, ...supplementaryNodes.value.map(n => ({ taskId: n.id, start: supplementary.value[n.id]?.start ?? '', end: n.kind === 'milestone' ? supplementary.value[n.id]?.start ?? '' : supplementary.value[n.id]?.end ?? '' }))];
  if (changes.length > 100) { error.value = '单次最多补齐 100 项日期。请先分段整理依赖链，再预览排期。'; return; }
  busy.value = true;
  try {
    preview.value = await previewPlan(plan.value, { expectedPlanVersion: plan.value.planVersion, changes, dependencyTargetId: props.task.id, incomingDependencies: edges.value, mode: mode.value, calculation: calculation.value }, props.actorId);
    idempotencyKey = crypto.randomUUID(); stale.value = false;
    void showTop();
  } catch (e) { fail(e); } finally { busy.value = false; }
}
async function apply() {
  if (!plan.value || !preview.value?.canApply || !canEdit.value || isBusy.value || props.disabled || stale.value) return;
  busy.value = true; error.value = '';
  try {
    await applyPlan(plan.value, preview.value, idempotencyKey, props.actorId);
    editing.value = false; preview.value = null; notice.value = '计划与依赖已保存，当前任务和来源视图已同步。';
    await load(); emit('saved');
  } catch (e) { fail(e); } finally { busy.value = false; }
}
const primaryLabel = computed(() => !canEdit.value ? '' : preview.value ? '确认保存调整' : editing.value ? '预览调整' : '调整计划');
const secondaryLabel = computed(() => preview.value ? '返回修改' : editing.value ? '取消计划编辑' : '');
const primaryDisabled = computed(() => isBusy.value || !!props.disabled || stale.value || !!confirmDiscard.value || (preview.value ? !preview.value.canApply || (!preview.value.changes.length && !preview.value.dependencyChanged) : false));
function primary() { if (primaryDisabled.value) return; if (preview.value) void apply(); else if (editing.value) void prepare(); else beginEdit(); }
function secondary() { if (isBusy.value) return; if (preview.value) { preview.value = null; void showTop(); return; } if (isDirty.value) confirmDiscard.value = 'cancel'; else { reset(); editing.value = false; } }
watch(() => props.planVersion, version => {
  if (version === plan.value?.planVersion) return;
  if (isDirty.value) { preview.value = null; stale.value = true; error.value = '计划版本已变化，填写内容已保留。请重新读取计划并核对后预览。'; }
  else if (!isBusy.value) void load();
});
watch(() => props.actorId, () => { void load(isDirty.value); });
onMounted(() => void load());
defineExpose({ isDirty, isBusy, canEdit, primaryLabel, secondaryLabel, primaryDisabled, primary, secondary, beginEdit });
</script>

<template>
  <div ref="root" class="task-plan-panel">
    <p v-if="loading" role="status" class="td-field-note">正在读取计划与权限…</p>
    <div v-if="error" class="td-error" role="alert"><p>{{ error }}</p><button v-if="stale || !plan" class="td-text-button" :disabled="isBusy" @click="load(isDirty)">重新读取计划（保留填写内容）</button></div>
    <p v-if="notice" class="td-notice" role="status">{{ notice }}</p>
    <template v-if="plan">
      <p v-if="lockReason" class="td-callout" role="note">{{ lockReason }}</p>
      <section v-if="confirmDiscard" class="td-leave-panel" role="alert"><h3>{{ confirmDiscard === 'dates' ? '切换后将丢弃本次日期修改' : '放弃本次计划修改？' }}</h3><p>{{ confirmDiscard === 'dates' ? '依赖草稿继续保留；所有日期恢复为已保存的值。' : '基本信息和评论草稿继续保留。' }}</p><div class="td-inline-buttons"><button class="button" @click="confirmDiscard = null">继续编辑</button><button class="button" @click="discardConfirmed">{{ confirmDiscard === 'dates' ? '丢弃日期修改并切换' : '放弃计划修改' }}</button></div></section>
      <template v-if="preview">
        <h3>确认计划调整</h3><p class="td-field-note">当前计划 V{{ preview.basePlanVersion }} · 已发布基线保持原样</p>
        <p class="td-callout">{{ preview.calculation === 'relationships_only' ? '仅保存依赖关系，所有日期保持原样。' : '保存后同步当前任务及联动任务的计划日期。' }}</p>
        <p>{{ preview.changes.length }} 项日期调整 · {{ preview.affectedMilestoneIds.length }} 个里程碑受影响</p>
        <ul v-if="dependencyDiff.length" class="tp-diff"><li v-for="text in dependencyDiff" :key="text">{{ text }}</li></ul>
        <article v-for="change in preview.changes" :key="change.taskId" class="td-section tp-change"><h4>{{ change.title }} · {{ change.direct ? '直接调整' : '依赖联动' }}</h4><p class="td-subtle">原：{{ change.previousStart || '待排期' }} → {{ change.previousEnd || '待排期' }}</p><p>新：{{ change.start }} → {{ change.end }}</p></article>
        <p v-if="!preview.changes.length" class="td-field-note">没有日期变化。{{ preview.dependencyChanged ? '将保存以上依赖变更。' : '请返回修改日期或依赖。' }}</p>
        <article v-for="issue in relevantIssues" :key="issue.id" :class="issue.severity === 'error' ? 'td-error' : 'td-callout'" class="tp-issue"><strong>{{ issue.title }}</strong><p>{{ issue.description }}</p></article>
        <details v-if="otherIssues.length"><summary class="td-text-button">其他计划提示（{{ otherIssues.length }}）</summary><article v-for="issue in otherIssues" :key="issue.id" class="td-callout tp-issue"><strong>{{ issue.title }}</strong><p>{{ issue.description }}</p></article></details>
        <p class="td-field-note">预览有效至 {{ new Date(preview.expiresAt).toLocaleTimeString('zh-CN', { hour12: false }) }}。保存时会再次校验权限与版本。</p>
      </template>
      <form v-else-if="editing && canEdit" class="td-form" @submit.prevent="prepare">
        <fieldset :disabled="isBusy || disabled || !!confirmDiscard">
          <label class="td-field">保存方式<select aria-label="保存方式" :value="calculation" @change="switchCalculation"><option value="schedule">调整日期与依赖，预览后保存</option><option value="relationships_only">仅保存依赖，保留所有日期</option></select></label>
          <div class="td-form-grid"><label class="td-field">计划开始<input v-model="start" type="date" :disabled="calculation === 'relationships_only'"/></label><label class="td-field">计划结束<input v-model="end" type="date" :min="start" :disabled="calculation === 'relationships_only'"/></label></div>
          <p class="td-field-note">{{ calendarDescription(plan.calendar) }}。日期须为工作日，依赖间隔按工作日计算。</p>
          <section v-if="calculation === 'schedule' && supplementaryNodes.length" class="td-section"><h3>补齐依赖链日期</h3><p class="td-field-note">相关任务尚未完整排期。填写全部缺失日期后统一预览，确认前不会写入任何任务。</p><article v-for="n in supplementaryNodes" :key="n.id" class="tp-change"><h4>{{ n.wbs }} · {{ n.title }}</h4><template v-if="supplementary[n.id]"><p v-if="n.status === 'done' || n.milestoneState === 'submitted'" class="td-warning-text">当前记录已锁定，请先处理完成或验收状态。</p><div class="td-form-grid"><label class="td-field">{{ n.kind === 'milestone' ? '里程碑日期' : '开始日期' }}<input v-model="supplementary[n.id]!.start" type="date" :aria-label="`补齐开始 ${n.title}`" :disabled="n.status === 'done' || n.milestoneState === 'submitted'"/></label><label v-if="n.kind !== 'milestone'" class="td-field">结束日期<input v-model="supplementary[n.id]!.end" type="date" :min="supplementary[n.id]!.start" :aria-label="`补齐结束 ${n.title}`" :disabled="n.status === 'done'"/></label></div></template></article></section>
          <div v-if="connectedMissing.length" class="td-callout tp-issue"><strong>依赖链有 {{ connectedMissing.length }} 项待排期</strong><p>{{ connectedMissing.map(n => n.title).join('、') }}</p><p>可先保存依赖关系；补齐日期后再预览联动排期。</p></div>
          <div class="td-section-heading"><h3>前置依赖</h3><button type="button" class="td-text-button" @click="edges.push({ predecessorId: '', lagDays: 0 })">＋ 添加依赖</button></div>
          <label class="td-field">搜索前置对象<input v-model="search" type="search" placeholder="按名称或 WBS 搜索任务、里程碑"/></label>
          <p v-if="!edges.length" class="td-empty-inline">暂无前置依赖，可添加任务或里程碑。</p>
          <div v-for="(edge, index) in edges" :key="index" class="tp-edge">
            <label class="td-field tp-target">前置对象 {{ index + 1 }}<select v-model="edge.predecessorId" :aria-label="`前置对象 ${index + 1}`"><option value="" disabled>选择前置任务或里程碑</option><option v-for="n in options(edge.predecessorId)" :key="n.id" :value="n.id">{{ n.wbs }} · {{ n.title }}</option></select></label>
            <span class="td-field-note">完成 → 开始（FS）</span><label class="td-field">间隔（工作日）<input v-model.number="edge.lagDays" :aria-label="`依赖间隔 ${index + 1}`" type="number" min="0" max="260" step="1" required/></label><button type="button" class="td-text-button" :aria-label="`移除依赖 ${index + 1}`" @click="edges.splice(index, 1)">移除</button>
          </div>
          <label v-if="calculation === 'schedule'" class="td-field">后续任务处理<select v-model="mode"><option value="push_successors">仅顺延冲突任务，保留余量</option><option value="earliest_start">按依赖重新计算最早开始日</option></select></label>
        </fieldset>
      </form>
      <template v-else>
        <h3>计划日期</h3><dl class="td-facts"><div><dt>计划开始</dt><dd>{{ node?.start || '待排期' }}</dd></div><div><dt>计划结束</dt><dd>{{ node?.end || '待排期' }}</dd></div><div><dt>工期</dt><dd>{{ node?.durationDays == null ? '待排期' : `${node.durationDays} 工作日` }}</dd></div></dl>
        <section class="td-section"><h3>前置依赖 · {{ incoming.length }} 项</h3><p v-if="!incoming.length" class="td-empty-inline">暂无前置依赖。{{ canEdit ? '点击调整计划可设置。' : '' }}</p><button v-for="d in incoming" :key="d.predecessorId" class="td-related-task" @click="openRelated(d.predecessorId)"><span><strong>{{ label(d.predecessorId) }}</strong><small>完成 → 开始（FS） · 间隔 {{ d.lagDays }} 工作日</small></span><span>查看 ›</span></button></section>
      </template>
      <section class="td-section"><h3>后续依赖 · {{ outgoing.length }} 项</h3><p class="td-field-note">后续关系只读，需进入后续任务调整其前置依赖。</p><p v-if="!outgoing.length" class="td-empty-inline">暂无后续依赖。</p><button v-for="d in outgoing" :key="d.successorId" class="td-related-task" @click="openRelated(d.successorId)"><span><strong>{{ label(d.successorId) }}</strong><small>完成 → 开始（FS） · 间隔 {{ d.lagDays }} 工作日</small></span><span>查看 ›</span></button></section>
    </template>
  </div>
</template>

<style scoped>
.task-plan-panel{min-width:0}.task-plan-panel h3{font-size:15px}.tp-edge{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;padding:12px 0;border-bottom:1px solid var(--line)}.tp-target{grid-column:1/-1}.tp-edge>.td-field-note{align-self:center}.tp-edge>button{justify-self:start}.tp-issue{display:block;overflow-wrap:anywhere}.tp-issue p{margin:6px 0}.tp-diff{padding-left:20px;font-size:13px;overflow-wrap:anywhere}.tp-diff li{margin:8px 0}.tp-change p{font-size:13px}.task-plan-panel .td-related-task>span:last-child{flex-shrink:0;font-size:12px}.task-plan-panel fieldset{min-width:0}.task-plan-panel select{max-width:100%}
</style>
