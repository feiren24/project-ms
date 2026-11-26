<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ProjectMember } from '../../../../shared/src/settings';
import type { MembershipRemovalPreview } from '../../../../shared/src/projects';
import { previewMembershipRemoval, removeMembership } from '../../api/projects';
import { PlanningError } from '../../api/planning';
import './projects.css';
const props = defineProps<{ projectId: string; member: ProjectMember }>();
const emit = defineEmits<{ close: []; saved: [] }>();
const router = useRouter(), dialog = ref<HTMLDialogElement>(), preview = ref<MembershipRemovalPreview>();
const reason = ref(''), loading = ref(false), busy = ref(false), error = ref(''), stale = ref(false);
let key = crypto.randomUUID(), disposed = false;
watch(reason, () => { key = crypto.randomUUID(); });
const kindLabels = { milestone: '里程碑', task: '未完成任务', review: '任务验收责任', risk: '未关闭风险', workstream: '启用工作分组', protection: '成员保护' };
async function load() {
  if (busy.value || loading.value) return;
  loading.value = true; error.value = '';
  try { const result = await previewMembershipRemoval(props.projectId, props.member.id); if (!disposed) { preview.value = result; stale.value = false; key = crypto.randomUUID(); } }
  catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '责任检查失败，请重试。'; }
  finally { if (!disposed) loading.value = false; }
}
function close() { if (!busy.value && (!reason.value.trim() || window.confirm('移除尚未提交，关闭将丢弃填写的原因。是否关闭？'))) emit('close'); }
async function save() {
  if (!preview.value?.canRemove || !reason.value.trim() || busy.value || loading.value || stale.value) return;
  busy.value = true; error.value = '';
  try {
    await removeMembership(props.projectId, props.member.id, { expectedVersion: preview.value.version, expectedPlanVersion: preview.value.planVersion, reason: reason.value.trim() }, key);
    reason.value = ''; busy.value = false; emit('saved');
  } catch (e) { error.value = e instanceof Error ? e.message : '移除失败，原因已保留，请重试。'; stale.value = e instanceof PlanningError && [403, 409].includes(e.status); }
  finally { busy.value = false; }
}
async function inspect(item: MembershipRemovalPreview['blockers'][number]) {
  if (busy.value || item.kind === 'protection') return;
  if (item.kind === 'milestone') { await router.push({name:'plan',params:{projectId:props.projectId},query:{view:'milestones',milestone:item.id}}); return; }
  const location = item.kind === 'workstream' ? { name: 'workstreams', params: { projectId: props.projectId }, query: { groupId: item.id } }
    : { name: item.kind === 'risk' ? 'risk-detail' : 'task-detail', params: { projectId: props.projectId, [item.kind === 'risk' ? 'riskId' : 'taskId']: item.id } };
  await router.push(location);
}
const removeGuard = router.beforeEach(() => !busy.value && (!reason.value.trim() || window.confirm('移除尚未提交，离开将丢弃填写的原因。是否离开？')));
function beforeUnload(event: BeforeUnloadEvent) { if (busy.value || reason.value.trim()) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { dialog.value?.showModal(); void load(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { disposed = true; removeGuard(); dialog.value?.close(); window.removeEventListener('beforeunload', beforeUnload); });
</script>
<template>
 <dialog ref="dialog" class="project-dialog" aria-labelledby="remove-member-title" @cancel.prevent="close">
  <header><h2 id="remove-member-title">移除项目成员 · {{ member.name }}</h2><button class="project-text" :disabled="busy" aria-label="关闭移除成员" @click="close">关闭</button></header>
  <form @submit.prevent="save"><div class="project-dialog-body">
   <p class="project-notice">移除后，该成员将无法访问此项目。登录账号、其他项目权限及历史记录保留。</p>
   <p class="settings-muted">系统管理员的全局访问资格独立于项目成员关系。</p>
   <p v-if="loading" role="status">正在检查成员责任与权限…</p>
   <p v-if="error" class="project-error" role="alert">{{ error }}<button v-if="stale || !preview" class="project-text" type="button" :disabled="busy || loading" @click="load">重新检查并保留原因</button></p>
   <section v-if="preview"><h3>待移交事项</h3>
    <ul v-if="preview.blockers.length" class="member-removal-blockers"><li v-for="(item, index) in preview.blockers" :key="`${item.kind}:${item.id}:${index}`"><div><strong>{{ kindLabels[item.kind] }} · {{ item.title }}</strong><p>{{ item.message }}</p></div><button v-if="item.kind !== 'protection'" class="project-text" type="button" :disabled="busy" @click="inspect(item)">查看事项</button></li></ul>
    <p v-else class="project-notice">没有待移交事项，可以移除。提交时会再次检查最新责任。</p>
    <p v-if="preview.blockers.some(b => b.kind === 'review' || b.kind === 'risk')" class="settings-muted">正在验收或关闭复核的事项，请先退回，再移交责任并重新提交。</p>
    <button class="project-text" type="button" :disabled="busy || loading" @click="load">重新检查责任</button>
   </section>
   <label>移除原因<textarea v-model="reason" aria-label="移除原因" required maxlength="500" rows="3" :disabled="busy" placeholder="说明移除原因，以便后续追溯"></textarea></label>
  </div><footer><button class="button" type="button" :disabled="busy" @click="close">取消</button><button class="button member-remove-confirm" :disabled="busy || loading || stale || !preview?.canRemove || !reason.trim()">{{ busy ? '正在移除…' : '确认移除成员' }}</button></footer></form>
 </dialog>
</template>
