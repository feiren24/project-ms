<script setup lang="ts">
import { calendarDescription } from '../../utils/project-presentation';
import { computed, onMounted, onBeforeUnmount, ref } from 'vue';
import { useRouter } from 'vue-router';
import Icon from '../../components/Icon.vue';
import { useAuthStore } from '../../stores/auth';
import { publishBaseline, PlanningError } from '../../api/planning';
import type { ProjectPlan } from '../../../../shared/src/planning';
const props = defineProps<{ plan: ProjectPlan; readOnly?: boolean }>();
const emit = defineEmits<{ close: []; saved: [message: string]; stale: [] }>();
const auth = useAuthStore();
const publisher = computed(() => auth.session?.legacyDemo ? '周亦安（示例身份）' : auth.user?.name || '当前登录账号');
const dialog = ref<HTMLDialogElement>();
const name = ref(`计划基线 V${props.plan.baselines.length + 1}`), reason = ref(''), exclusionReason = ref('');
const confirmed = ref(false), excluded = ref<string[]>([]), stage = ref<'edit'|'confirm'>('edit');
const gaps = computed(() => props.plan.nodes.filter(n => n.kind === 'gap'));
const incomplete = computed(() => props.plan.nodes.filter(n => n.kind === 'task' && (!n.start || !n.end || !n.owner || !n.effortHours)));
const busy = ref(false), error = ref(''), sessionChanged = ref(false);
let reviewVersion = props.plan.planVersion;
function review() {
  if (props.readOnly) return;
  if (gaps.value.some(n => !excluded.value.includes(n.id))) { error.value = '请明确处理每一项待排期内容；本次排除的内容会记录在基线中。'; return; }
  reviewVersion = props.plan.planVersion; error.value = ''; stage.value = 'confirm';
}
async function save() {
  if (props.readOnly || busy.value) return;
  busy.value = true; error.value = '';
  try { await publishBaseline(props.plan, { expectedPlanVersion: reviewVersion, name: name.value.trim(), reason: reason.value.trim(), calendarConfirmed: confirmed.value, excludedIds: excluded.value, exclusionReason: exclusionReason.value.trim() }); emit('saved', '基线已发布，当前日期、依赖和日历快照已保留。'); }
  catch (e) { error.value = e instanceof Error ? e.message : '基线暂时无法发布，请重试。'; if (e instanceof PlanningError && e.status === 403) sessionChanged.value = true; if (e instanceof PlanningError && e.status === 409) { stage.value = 'edit'; emit('stale'); } }
  finally { busy.value = false; }
}
onMounted(() => dialog.value?.showModal()); onBeforeUnmount(() => dialog.value?.close());
const navigationDirty = computed(() => !!reason.value || !!exclusionReason.value || confirmed.value || excluded.value.length > 0 || name.value !== `计划基线 V${props.plan.baselines.length + 1}`);
function confirmNavigation() { return !busy.value && (!navigationDirty.value || window.confirm('计划修改尚未保存，离开将丢弃填写内容。是否离开？')); }
const removeNavigationGuard = useRouter().beforeEach((to, from) => to.name === from.name && to.params.projectId === from.params.projectId ? true : confirmNavigation());
function protectUnload(event: BeforeUnloadEvent) { if (navigationDirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => window.addEventListener('beforeunload', protectUnload));
onBeforeUnmount(() => { removeNavigationGuard(); window.removeEventListener('beforeunload', protectUnload); });
</script>
<template>
  <dialog ref="dialog" class="plan-dialog" aria-labelledby="baseline-title" @close="emit('close')" @cancel="e => { if (busy) e.preventDefault(); }">
    <header class="plan-dialog-header"><div><span class="eyebrow">PLAN BASELINE</span><h2 id="baseline-title">{{ stage === 'edit' ? '发布计划基线' : '确认基线范围' }}</h2></div><button class="icon-button" aria-label="关闭基线窗口" :disabled="busy" @click="dialog?.close()"><Icon name="close"/></button></header>
    <div class="plan-dialog-body"><p v-if="readOnly" class="plan-error" role="alert">当前没有发布基线权限，填写内容已保留。</p>
      <div class="plan-callout"><Icon name="flag" :size="18"/><p>基线是当前计划的固定快照，用来对比后续变更。发布后保留日期、依赖与工作日历，现有基线不会被覆盖。</p></div>
      <div v-if="incomplete.length" class="plan-error" role="alert">{{ incomplete.length }} 项任务尚未具备完整排期、负责人或工时，补齐后才能发布基线。<p v-for="node in incomplete" :key="node.id">{{ node.title }}</p></div>
      <form v-if="stage === 'edit'" id="baseline-form" @submit.prevent="review">
        <label class="plan-form-block">基线名称<input v-model="name" required maxlength="80"/></label>
        <label class="plan-form-block">发布说明<textarea v-model="reason" rows="3" required maxlength="500" placeholder="说明这版计划的目标与确认依据"></textarea></label>
        <h3>工作日历确认</h3><p class="plan-description">{{ calendarDescription(plan.calendar) }}</p>
        <label class="plan-checkbox"><input v-model="confirmed" type="checkbox" required/>我确认本次{{ plan.project.isDemo ? '示例基线' : '基线' }}采用上述工作日历</label>
        <template v-if="gaps.length"><h3>待排期内容 · {{ gaps.length }} 项</h3><p class="plan-description">未明确范围的内容不能当作已排期；本次排除须留痕。</p><label v-for="gap in gaps" :key="gap.id" class="plan-checkbox"><input v-model="excluded" type="checkbox" :value="gap.id"/>本次排除：{{ gap.title }}</label><label class="plan-form-block">排除原因<textarea v-model="exclusionReason" rows="2" maxlength="500" required placeholder="例如：运营目标需业务方进一步拆解后纳入下一版"></textarea></label></template>
      </form>
      <template v-else><dl class="plan-facts"><div><dt>基线名称</dt><dd>{{ name }}</dd></div><div><dt>计划版本</dt><dd>V{{ reviewVersion }}</dd></div><div><dt>纳入计划项</dt><dd>{{ plan.nodes.filter(n => n.kind !== 'group' && !excluded.includes(n.id)).length }} 项</dd></div><div><dt>明确排除</dt><dd>{{ excluded.length }} 项</dd></div></dl><h3>发布说明</h3><p class="plan-description">{{ reason }}</p><template v-if="excluded.length"><h3>排除依据</h3><p class="plan-description">{{ exclusionReason }}</p></template><p class="plan-field-note">记录发布人：{{ publisher }}。保存后可在基线选择器和变更记录中查看。</p></template>
      <div v-if="error" class="plan-error" role="alert">{{ error }}<button v-if="sessionChanged" class="plan-text-button" @click="emit('stale'); sessionChanged = false; stage = 'edit'; error = ''">重新读取计划（保留填写内容）</button></div>
    </div>
    <footer class="plan-dialog-footer"><button class="button" :disabled="busy" @click="stage === 'confirm' ? stage = 'edit' : dialog?.close()">{{ stage === 'confirm' ? '返回修改' : '取消' }}</button><button v-if="stage === 'edit'" class="button primary" form="baseline-form" :disabled="busy || readOnly || !!incomplete.length">核对发布范围</button><button v-else class="button primary" :disabled="busy || readOnly" @click="save">{{ busy ? '正在发布…' : plan.project.isDemo ? '确认发布示例基线' : '确认发布基线' }}</button></footer>
  </dialog>
</template>
