<script setup lang="ts">
import { calendarDescription } from '../../utils/project-presentation';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../../components/Icon.vue';
import { applyPlan, previewPlan, PlanningError } from '../../api/planning';
import type { PlanNode, ProjectPlan, PlanPreview } from '../../../../shared/src/planning';
const props = defineProps<{ readOnly?: boolean; plan: ProjectPlan; node: PlanNode; proposal?: { start: string; end: string }; initialDependencies?: string[] }>();
const emit = defineEmits<{ close: []; saved: [message: string]; stale: [] }>();
const dialog = ref<HTMLDialogElement>();
const start = ref(props.proposal?.start || props.node.start || '');
const end = ref(props.proposal?.end || props.node.end || '');
const mode = ref<'push_successors' | 'earliest_start'>('push_successors');
const edges = ref(props.plan.dependencies.filter(d => d.successorId === props.node.id).map(d => ({ predecessorId: d.predecessorId, lagDays: d.lagDays })));
if (props.initialDependencies) for (const id of props.initialDependencies) if (!edges.value.some(e => e.predecessorId === id)) edges.value.push({predecessorId:id,lagDays:0});
const candidates = computed(() => props.plan.nodes.filter(n => ['task','milestone'].includes(n.kind) && n.id !== props.node.id));
const editable = computed(() => !props.readOnly && ['task','milestone'].includes(props.node.kind) && props.node.status !== 'done');
const preview = ref<PlanPreview | null>(null);
const busy = ref(false), error = ref(''), stale = ref(false), sessionChanged = ref(false);
let idempotencyKey = '';
const status = (value: string) => ({ todo:'待办', in_progress:'进行中', done:'已完成', review:'待验收' }[value] || value);
function close() { if (!busy.value) dialog.value?.close(); }
async function prepare() {
  if (!editable.value || busy.value) return;
  if (!start.value || !(props.node.kind === 'milestone' ? start.value : end.value)) { error.value = '请填写完整的计划日期。'; return; }
  if (edges.value.some(e => !e.predecessorId)) { error.value = '请选择前置任务，或移除空的依赖行。'; return; }
  busy.value = true; error.value = ''; stale.value = false;
  try {
    preview.value = await previewPlan(props.plan, { expectedPlanVersion: props.plan.planVersion, changes: [{ taskId: props.node.id, start: start.value, end: props.node.kind === 'milestone' ? start.value : end.value }], dependencyTargetId: props.node.id, incomingDependencies: edges.value, mode: mode.value });
    idempotencyKey = crypto.randomUUID();
  } catch (e) { handleError(e); }
  finally { busy.value = false; }
}
function handleError(e: unknown) {
  error.value = e instanceof Error ? e.message : '暂时无法处理，请重试。';
  if (e instanceof PlanningError && e.status === 403) sessionChanged.value = true;
  if (e instanceof PlanningError && e.status === 409) { stale.value = true; emit('stale'); }
}
async function apply() {
  if (!editable.value || busy.value || !preview.value || !preview.value.canApply || stale.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await applyPlan(props.plan, preview.value, idempotencyKey);
    emit('saved', `计划已保存，${result.affectedCount} 项计划更新已同步到总览。`);
  } catch (e) { handleError(e); }
  finally { busy.value = false; }
}
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
const originalEdges = JSON.stringify(edges.value);
const navigationDirty = computed(() => editable.value && (start.value !== (props.node.start || '') || end.value !== (props.node.end || '') || JSON.stringify(edges.value) !== originalEdges || mode.value !== 'push_successors'));
function confirmNavigation() { return !busy.value && (!navigationDirty.value || window.confirm('计划修改尚未保存，离开将丢弃填写内容。是否离开？')); }
const removeNavigationGuard = useRouter().beforeEach((to, from) => to.name === from.name && to.params.projectId === from.params.projectId ? true : confirmNavigation());
function protectUnload(event: BeforeUnloadEvent) { if (navigationDirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => window.addEventListener('beforeunload', protectUnload));
onBeforeUnmount(() => { removeNavigationGuard(); window.removeEventListener('beforeunload', protectUnload); });
</script>
<template>
  <dialog ref="dialog" class="plan-dialog plan-editor" aria-labelledby="plan-edit-title" @close="emit('close')" @cancel="e => { if (busy) e.preventDefault(); }">
    <header class="plan-dialog-header"><div><span class="eyebrow">{{ preview ? 'CHANGE PREVIEW' : 'PLAN DETAILS' }}</span><h2 id="plan-edit-title">{{ preview ? '确认计划调整' : '计划详情' }}</h2></div><button class="icon-button" aria-label="关闭计划详情" :disabled="busy" @click="close"><Icon name="close"/></button></header>
    <div class="plan-dialog-body">
      <span class="plan-kicker">{{ node.wbs }} · {{ status(node.status) }} <span v-if="plan.project.isDemo" class="demo-label">DEMO</span></span>
      <h3 class="plan-task-title">{{ node.title }}</h3>
      <p class="plan-description">{{ node.description }}</p>
      <template v-if="!preview">
        <dl class="plan-facts"><div><dt>负责人</dt><dd>{{ node.owner || '待明确' }}</dd></div><div><dt>计划投入</dt><dd>{{ node.effortHours === null ? '待估算' : `${node.effortHours} 小时` }}</dd></div><div><dt>当前进度</dt><dd>{{ node.progress }}%</dd></div><div><dt>当前工期</dt><dd>{{ node.durationDays === null ? '待排期' : `${node.durationDays} 工作日` }}</dd></div></dl>
        <div v-if="!editable" class="plan-callout"><Icon name="info" :size="18"/><p>{{ node.kind === 'gap' ? '原始目标中的运营范围仍待细化。暂不虚构任务、日期和投入，发布基线时需要明确记录排除原因。' : node.kind === 'group' ? '工作分组日期由下属任务自动汇总。展开甘特图中的工作分组，选择具体任务调整排期。' : readOnly ? '当前账号仅可查看计划，调整排期需要项目负责人或管理员权限。' : '已完成任务的日期已锁定，保留历史交付记录。' }}</p></div>
        <form v-else id="plan-edit-form" @submit.prevent="prepare">
          <div class="plan-form-row"><label>{{ node.kind === 'milestone' ? '里程碑日期' : '开始日期' }}<input v-model="start" type="date" required :disabled="busy"/></label><label v-if="node.kind !== 'milestone'">结束日期<input v-model="end" type="date" required :min="start" :disabled="busy"/></label></div>
          <p class="plan-field-note">{{ calendarDescription(plan.calendar) }}。日期须为工作日。</p>
          <div class="plan-form-heading"><h4>前置依赖 <small>完成 → 开始（FS）</small></h4><button type="button" class="plan-text-button" :disabled="busy" @click="edges.push({ predecessorId: '', lagDays: 0 })">＋ 添加依赖</button></div>
          <p v-if="!edges.length" class="plan-field-note">暂无前置依赖，可独立排期。</p>
          <div v-for="(edge, index) in edges" :key="index" class="plan-edge-row"><label class="plan-edge-target">前置任务<select v-model="edge.predecessorId" :aria-label="`前置任务 ${index + 1}`" required :disabled="busy"><option value="" disabled>选择前置任务</option><option v-for="n in candidates" :key="n.id" :value="n.id">{{ n.wbs }} {{ n.title }}</option></select></label><label>间隔（工作日）<input v-model.number="edge.lagDays" :aria-label="`依赖间隔 ${index + 1}`" type="number" min="0" max="260" required :disabled="busy"/></label><button type="button" class="icon-button" :aria-label="`移除依赖 ${index + 1}`" :disabled="busy" @click="edges.splice(index, 1)"><Icon name="close" :size="16"/></button></div>
          <label class="plan-form-block">后续任务处理<select v-model="mode" :disabled="busy"><option value="push_successors">仅顺延冲突的后续任务（保留原有余量）</option><option value="earliest_start">按依赖重新计算后续任务最早开始日</option></select></label>

        </form>
      </template>
      <template v-else>
        <div class="plan-preview-summary"><b>{{ preview.changes.length }}</b><span>项日期调整</span><b>{{ preview.affectedMilestoneIds.length }}</b><span>个里程碑受影响</span></div>
        <p class="plan-description">{{ preview.reason }}</p>
        <div class="plan-callout"><Icon name="info" :size="18"/><p>即将更新当前计划 V{{ preview.basePlanVersion }}，并同步总览。已发布基线保持原样。{{ preview.dependencyChanged ? '前置依赖也将一并更新。' : '' }}</p></div>
        <div v-for="change in preview.changes" :key="change.taskId" class="plan-change-row"><h4>{{ change.title }} <small>{{ change.direct ? '直接调整' : '依赖联动' }}</small></h4><p><span class="plan-old-date">{{ change.previousStart }} → {{ change.previousEnd }}</span></p><p>{{ change.start }} → {{ change.end }} <strong :class="change.shiftDays > 0 ? 'orange-text' : ''">{{ change.shiftDays > 0 ? '+' : '' }}{{ change.shiftDays }} 天</strong></p></div>
        <p v-if="!preview.changes.length" class="plan-field-note">没有日期变化。{{ preview.dependencyChanged ? '将仅保存依赖关系变更。' : '请返回修改日期或依赖。' }}</p>
        <div v-for="issue in preview.issues" :key="issue.id" class="plan-issue" :class="issue.severity"><b>{{ issue.title }}</b><p>{{ issue.description }}</p></div>
        <p class="plan-field-note">预览有效至 {{ new Date(preview.expiresAt).toLocaleTimeString('zh-CN', { hour12: false }) }}，保存时会再次校验版本。</p>
      </template>
      <div v-if="error" class="plan-error" role="alert">{{ error }}<button v-if="sessionChanged" class="plan-text-button" @click="emit('stale'); sessionChanged = false; preview = null; error = ''">重新读取计划（保留填写内容）</button><p v-if="stale">已重新读取最新计划；返回修改后可重新生成预览，填写内容会保留。</p></div>
    </div>
    <footer class="plan-dialog-footer"><template v-if="preview"><button class="button" :disabled="busy" @click="preview = null; error = ''; stale = false">返回修改</button><button class="button primary" :disabled="busy || !editable || !preview.canApply || stale || (!preview.changes.length && !preview.dependencyChanged)" @click="apply">{{ busy ? '正在保存…' : '确认保存调整' }}</button></template><template v-else><button class="button" :disabled="busy" @click="close">{{ editable ? '取消' : '返回计划' }}</button><button v-if="editable" class="button primary" form="plan-edit-form" :disabled="busy">{{ busy ? '正在计算…' : '预览调整' }}</button></template></footer>
  </dialog>
</template>
