<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ManagedWorkstream, WorkstreamDraft, WorkstreamWorkspace } from '../../../../shared/src/workstreams';
import { fetchWorkstreams, saveWorkstream, type WorkstreamOperation } from '../../api/workstreams';
import { PlanningError } from '../../api/planning';
import { useAuthStore } from '../../stores/auth';
import '../projects/projects.css';
const props = defineProps<{ workspace: WorkstreamWorkspace; operation: WorkstreamOperation; stream?: ManagedWorkstream; actorId: string }>();
const emit = defineEmits<{ close: []; saved: [workspace: WorkstreamWorkspace, message: string] }>();
const auth = useAuthStore(), dialog = ref<HTMLDialogElement>(), base = ref(props.workspace);
const draft = reactive<WorkstreamDraft>({ name: props.stream?.name || '', description: props.stream?.description || '', ownerId: props.stream?.ownerId ?? null, color: props.stream?.color || 'blue' });
const colors = { blue: '蓝色', cyan: '青色', purple: '紫色', orange: '橙色', green: '绿色', slate: '灰色' };
const moving = computed(() => props.operation === 'up' || props.operation === 'down');
const directConfirm = computed(() => !['create', 'edit'].includes(props.operation));
const confirming = ref(directConfirm.value), busy = ref(false), stale = ref(false), error = ref(''), committed = ref(false);
const recovered = ref(false), conflictReviewed = ref(false);
const initial = JSON.stringify(draft), dirty = computed(() => !committed.value && (JSON.stringify(draft) !== initial));
const editing = computed(() => ['create', 'edit'].includes(props.operation));
const current = computed(() => base.value.workstreams.find(item => item.id === props.stream?.id));
const conflictFields = computed(() => [
  { label: '工作分组名称', latest: current.value?.name, local: draft.name },
  { label: '分组说明', latest: current.value?.description || '未填写', local: draft.description || '未填写' },
  { label: '协调负责人', latest: current.value?.owner || '未指定', local: base.value.actors.find(actor => actor.id === draft.ownerId)?.name || (draft.ownerId ? props.stream?.owner || draft.ownerId : '未指定') },
  { label: '分组颜色', latest: current.value ? colors[current.value.color] : '', local: colors[draft.color] }
]);
const needsConflictReview = computed(() => recovered.value && editing.value && !!current.value && !conflictReviewed.value);
const desiredActive = !props.stream?.active;
const title = computed(() => props.operation === 'create' ? '新增工作分组' : props.operation === 'edit' ? '编辑工作分组' : props.operation === 'status' ? `${desiredActive ? '启用' : '停用'}工作分组` : `${props.operation === 'up' ? '上移' : '下移'}工作分组`);
const canManage = computed(() => base.value.canManage && (auth.session?.legacyDemo || !!auth.actorForProject(base.value.projectId)));
const owners = computed(() => base.value.actors.filter(actor => actor.assignable !== false));
const ownerMissing = computed(() => draft.ownerId && !owners.value.some(actor => actor.id === draft.ownerId));
let key = crypto.randomUUID(), disposed = false;
watch(draft, () => { key = crypto.randomUUID(); confirming.value = directConfirm.value; conflictReviewed.value = false; });
function confirmNavigation() { return !busy.value && (!dirty.value || window.confirm('工作分组修改尚未保存，离开将丢弃填写内容。是否离开？')); }
function close() { if (confirmNavigation()) emit('close'); }
function review() { if (!canManage.value || busy.value || stale.value || needsConflictReview.value) return; if (editing.value && !draft.name.trim()) { error.value = '请填写工作分组名称。'; return; } error.value = ''; confirming.value = true; }
async function save() {
  if (!canManage.value || busy.value || stale.value || needsConflictReview.value || !confirming.value) return;
  busy.value = true; error.value = '';
  try {
    const result = await saveWorkstream(base.value, props.actorId, props.operation, props.stream?.id, undefined, key, { ...draft, name: draft.name.trim(), description: draft.description.trim() }, desiredActive);
    if (disposed) return;
    committed.value = true; busy.value = false;
    emit('saved', result, `${title.value}已保存，当前计划和项目记录已同步。`);
  } catch (e) { if (disposed) return; error.value = e instanceof Error ? e.message : (moving.value ? '调整顺序失败，请重试。' : '保存失败，填写内容已保留。'); stale.value = e instanceof PlanningError && [403, 404, 409].includes(e.status); }
  finally { if (!disposed) busy.value = false; }
}
async function recover() {
  if (busy.value) return; busy.value = true; error.value = '';
  try { const result = await fetchWorkstreams(base.value.projectId, props.actorId); if (disposed) return; base.value = result; stale.value = props.operation !== 'create' && !current.value; recovered.value = true; conflictReviewed.value = false; confirming.value = directConfirm.value; key = crypto.randomUUID(); error.value = moving.value ? '已读取最新分组和权限，请重新确认移动操作。' : '已读取最新分组、权限与影响数量，填写内容已保留。请重新核对后提交。'; }
  catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '重新读取失败，请重试。'; }
  finally { if (!disposed) busy.value = false; }
}
const removeGuard = useRouter().beforeEach(() => confirmNavigation());
function protectUnload(event: BeforeUnloadEvent) { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', protectUnload); });
onBeforeUnmount(() => { disposed = true; removeGuard(); dialog.value?.close(); window.removeEventListener('beforeunload', protectUnload); });
</script>
<template>
 <dialog ref="dialog" class="project-dialog wg-dialog" aria-labelledby="workstream-dialog-title" @cancel.prevent="close">
  <header><div><span class="eyebrow">WORK GROUP</span><h2 id="workstream-dialog-title">{{ moving ? `确认${title}` : confirming ? '确认工作分组变更' : title }}</h2></div><button class="project-text" aria-label="关闭工作分组表单" :disabled="busy" @click="close">关闭</button></header>
  <form @submit.prevent="review"><div class="project-dialog-body">
   <p v-if="error" class="project-error" role="alert">{{ error }}<button v-if="stale" class="project-text" type="button" :disabled="busy" @click="recover">{{ moving ? '读取最新分组' : '读取最新分组并保留填写' }}</button></p>
   <p v-if="!canManage" class="project-error" role="alert">{{ moving ? '当前没有工作分组管理权限，请联系项目负责人。' : '当前没有工作分组管理权限，填写内容已保留。请联系项目负责人。' }}</p>
   <section v-if="recovered && editing && current" class="wg-conflict-review" aria-label="最新分组与本地草稿对比">
    <h3>核对最新分组与本地草稿</h3><p>其他修改已同步。请逐项比较；下方填写内容将作为本次保存结果，继续前可修改草稿。</p>
    <div class="wg-conflict-row wg-conflict-heading"><span>字段</span><strong>服务器最新值</strong><strong>本地草稿</strong></div>
    <div v-for="field in conflictFields" :key="field.label" class="wg-conflict-row"><strong>{{ field.label }}</strong><span>{{ field.latest }}</span><span>{{ field.local }}</span></div>
    <label class="wg-conflict-ack"><input v-model="conflictReviewed" type="checkbox" :disabled="busy || confirming"/>我已逐项核对，确认按当前草稿保存</label>
   </section>
   <template v-if="!confirming">
    <template v-if="editing"><label>工作分组名称<input v-model="draft.name" required maxlength="80" placeholder="例如：客户体验改进" :disabled="busy"/></label><label>分组说明<textarea v-model="draft.description" maxlength="1000" rows="3" placeholder="说明分组范围，帮助成员判断任务应放在哪里" :disabled="busy"/></label><label>协调负责人<select v-model="draft.ownerId" :disabled="busy"><option :value="null">未指定负责人</option><option v-if="ownerMissing" :value="draft.ownerId" disabled>{{ stream?.owner || draft.ownerId }}（原负责人已不可用）</option><option v-for="owner in owners" :key="owner.id" :value="owner.id">{{ owner.name }}</option></select></label><p class="wg-field-note">负责协调这个分组，不会因此获得额外项目权限。停用成员前需移交启用分组的协调责任。</p><label>分组颜色<select v-model="draft.color" :disabled="busy"><option v-for="(label, color) in colors" :key="color" :value="color">{{ label }}</option></select></label><span class="wg-color-preview" :data-color="draft.color">{{ colors[draft.color] }} · {{ draft.name || '工作分组' }}</span></template>
    <div v-else class="wg-operation-target"><span class="wg-dot" :data-color="current?.color || stream?.color"></span><strong>{{ current?.name || stream?.name }}</strong><span>{{ title }}</span></div>

   </template>
   <dl v-else class="project-facts"><div><dt>操作</dt><dd>{{ title }}</dd></div><div><dt>工作分组</dt><dd>{{ editing ? draft.name : current?.name || stream?.name }}</dd></div><template v-if="editing"><div><dt>说明</dt><dd>{{ draft.description || '未填写' }}</dd></div><div><dt>协调负责人</dt><dd>{{ owners.find(owner => owner.id === draft.ownerId)?.name || (draft.ownerId ? stream?.owner : '未指定') }}</dd></div><div><dt>颜色</dt><dd>{{ colors[draft.color] }}</dd></div></template></dl>
   <p v-if="operation === 'status' && !desiredActive" class="project-notice"><strong>当前有 {{ current?.taskCount ?? stream?.taskCount ?? 0 }} 项执行任务，其中 {{ current?.unfinishedCount ?? stream?.unfinishedCount ?? 0 }} 项未完成。</strong><br/>停用后，已有任务可以继续处理；不能再向此分组新增任务、子任务或风险应对任务。分组、任务和历史记录会保留，可随时重新启用。</p>
   <p v-else-if="operation === 'status'" class="project-notice">启用后，可以重新向此分组新增任务。原有任务和历史记录保持。</p>
   <p v-else-if="operation === 'up' || operation === 'down'" class="project-notice">调整此分组在全部分组中的顺序，同步总览和当前甘特图。任务编号、任务日期和历史基线保持。</p>
   <p v-else class="project-notice">{{ operation === 'create' ? '新分组默认启用，不会自动创建任务。' : '修改会同步当前计划中的分组名称、说明、负责人和颜色。' }}历史记录与已发布基线保持。</p>
  </div><footer><button type="button" class="button" :disabled="busy" @click="confirming && !directConfirm ? confirming = false : close()">{{ confirming && !directConfirm ? '返回修改' : '取消' }}</button><button v-if="!confirming" class="button primary" :disabled="busy || stale || needsConflictReview || !canManage">核对变更</button><button v-else type="button" class="button primary" :disabled="busy || stale || needsConflictReview || !canManage" @click="save">{{ busy ? '正在保存…' : moving ? (operation === 'up' ? '确认上移' : '确认下移') : '确认保存' }}</button></footer></form>
 </dialog>
</template>

<style scoped>
.wg-conflict-review{border:1px solid var(--line-strong);border-radius:12px;padding:12px;display:grid;gap:12px}.wg-conflict-review h3{font-size:14px}.wg-conflict-review p{font-size:12px;line-height:1.7;color:var(--secondary)}.wg-conflict-row{display:grid;grid-template-columns:72px minmax(0,1fr) minmax(0,1fr);gap:8px;font-size:12px;line-height:1.7}.wg-conflict-row>*{min-width:0;overflow-wrap:anywhere;white-space:pre-wrap}.wg-conflict-heading{padding-bottom:8px;border-bottom:1px solid var(--line)}.project-dialog .wg-conflict-ack{display:flex;align-items:center;gap:8px;min-height:44px;font-size:12px}.project-dialog .wg-conflict-ack input{width:18px;min-height:18px;flex:none}
</style>
