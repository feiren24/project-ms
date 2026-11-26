<script setup lang="ts">
import { computed, ref, nextTick, watch, onMounted, onBeforeUnmount } from 'vue';
import { useRouter } from 'vue-router';
import type { Milestone, MilestoneWorkspace, MilestoneDraft, MilestoneDelivery, MilestoneAction, MilestoneWriteResult } from '../../../../shared/src/milestones';
import { milestoneStateLabels } from '../../../../shared/src/milestones';
import { isProjectManager, canWriteProject, canReviewTask } from '../../../../shared/src/permissions';
import { fetchMilestones, saveMilestone, saveMilestoneDelivery, transitionMilestone } from '../../api/milestones';
import { PlanningError } from '../../api/planning';
import './milestones.css';
const props = defineProps<{ workspace: MilestoneWorkspace; milestone: Milestone | null; actorId: string }>();
const emit = defineEmits<{ close: []; saved: []; notify: [message: string]; schedule: [id: string, dependencies?: string[]]; created: [id: string, dependencies: string[]] }>();
const router = useRouter(), dialog = ref<HTMLDialogElement>();
const workspace = ref(props.workspace), current = ref(props.milestone);
const editing = ref(!props.milestone), tab = ref<'delivery'|'plan'|'history'>('delivery');
const recoveredDelivery = ref<MilestoneDelivery|null>(null);
const busy = ref(false), error = ref(''), stale = ref(false), action = ref<MilestoneAction|null>(null), reason = ref(''), scopeReason = ref('');
const checked = ref<string[]>([]), failed = ref<string[]>([]), dependencySelection = ref<string[]>([]);
const actor = computed(() => workspace.value.actors.find(a => a.id === props.actorId));
const manager = computed(() => isProjectManager(actor.value?.role));
const writable = computed(() => canWriteProject(actor.value?.role));
const deliveryEditable = computed(() => writable.value && current.value && (manager.value || current.value.ownerId === props.actorId) && ['draft','rejected','needs_review','legacy_achieved'].includes(current.value.state));
const latest = computed(() => current.value?.submissions.at(-1));
const reviewer = computed(() => current.value?.state === 'submitted' && canReviewTask(actor.value?.role, props.actorId, current.value.ownerId, latest.value?.submitterId || '', current.value.reviewerId));
const selfReview = computed(() => ['accept','reject'].includes(action.value || '') && (current.value?.ownerId === props.actorId || latest.value?.submitterId === props.actorId));
const requiredReason = computed(() => selfReview.value || ['cancel','restore','reopen'].includes(action.value || ''));
const editableMembers = computed(() => workspace.value.actors.filter(a => a.assignable !== false && canWriteProject(a.role)));
const tasks = computed(() => workspace.value.tasks.filter(t => t.taskKind !== 'summary' && !t.isContainer && t.status !== 'cancelled' && !workspace.value.tasks.some(c => c.parentId === t.id)));
const emptyDraft = (): MilestoneDraft => ({ title: '', description: '', workstreamId: workspace.value.workstreams.find(s => s.active !== false)?.id || '', ownerId: editableMembers.value.find(a => a.id === props.actorId)?.id || '', reviewerId: editableMembers.value.find(a => a.id !== props.actorId)?.id || '', date: null, criteria: [{ id: crypto.randomUUID(), title: '', kind: 'evidence', taskId: null }] });
const newId = () => crypto.randomUUID();
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const toDraft = (m: Milestone): MilestoneDraft => ({ title:m.title, description:m.description, workstreamId:m.workstreamId, ownerId:m.ownerId, reviewerId:m.reviewerId, date:m.date, criteria:copy(m.criteria) });
const draft = ref<MilestoneDraft>(current.value ? toDraft(current.value) : emptyDraft());
const delivery = ref<MilestoneDelivery>(copy(current.value?.delivery || { summary:'', links:[], evidence:[] }));
function ensureEvidence() { for (const c of (current.value?.criteria || []).filter(c => c.kind === 'evidence')) if (!delivery.value.evidence.some(e => e.criterionId === c.id)) delivery.value.evidence.push({ criterionId:c.id, description:'', links:[], declared:false }); }
ensureEvidence();
let initialDraft = JSON.stringify(draft.value), initialDelivery = JSON.stringify(delivery.value);
const dirty = computed(() => (editing.value && JSON.stringify(draft.value) !== initialDraft) || JSON.stringify(delivery.value) !== initialDelivery || !!reason.value || !!scopeReason.value);
const labels: Record<MilestoneAction,string> = { submit:'提交验收', withdraw:'撤回提交', accept:'验收通过', reject:'退回修改', cancel:'取消里程碑', restore:'恢复里程碑', reopen:'重开里程碑' };
const actionNote: Record<MilestoneAction,string> = { submit:'将保存本版成果、条件与关联任务状态的不可覆盖快照，并通知验收人。提交后成果内容锁定。', withdraw:'将撤回当前提交，恢复待提交状态；原提交记录保留。', accept:'将记录正式验收结果和服务端验收日期，关联后续计划可据此判断前置是否完成。', reject:'所选未通过条件将附于本次验收记录，负责人修订成果后重新提交。', cancel:'节点将退出达成率分母，不能再满足后续任务的前置依赖。日期、基线和历史仍保留。', restore:'节点将恢复为待提交，需要重新提交并验收，不恢复旧验收效力。', reopen:'将撤销当前验收效力，进入需复核；依赖此成果的后续验收可能需要复核，原快照仍保留。' };
const successors = computed(() => current.value ? workspace.value.dependencies.filter(d => d.predecessorId === current.value!.id).map(d => workspace.value.tasks.find(t => t.id === d.successorId)?.title || workspace.value.milestones.find(m => m.id === d.successorId)?.title || d.successorId) : []);
function urls(text: string) { return text.split(/\n/).map(s => s.trim()).filter(Boolean); }
function validLinks(links: string[]) { return links.every(s => { try { return ['https:', 'http:'].includes(new URL(s).protocol); } catch { return false; } }); }
function evidence(id: string) { return delivery.value.evidence.find(e => e.criterionId === id)!; }
function linkSafe(s: string) { return validLinks([s]) ? s : undefined; }
function time(value: string) { return new Date(value).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false }); }
function permitLeave() { return !busy.value && (!dirty.value || window.confirm('里程碑内容尚未保存，离开将丢弃填写内容。是否离开？')); }
let allowNextNavigation = false;
function close() { if (permitLeave()) { allowNextNavigation = true; emit('close'); } }
const removeGuard = router.beforeEach((to, from) => { if (allowNextNavigation) { allowNextNavigation = false; return true; } return to.fullPath === from.fullPath || permitLeave(); });
watch(error, message => { if (message) void nextTick(() => dialog.value?.querySelector<HTMLElement>('.plan-error')?.scrollIntoView({block:'nearest'})); });
function protectUnload(e: BeforeUnloadEvent) { if (dirty.value || busy.value) { e.preventDefault(); e.returnValue = ''; } }
onMounted(() => { dialog.value?.showModal(); window.addEventListener('beforeunload', protectUnload); });
onBeforeUnmount(() => { removeGuard(); dialog.value?.close(); window.removeEventListener('beforeunload', protectUnload); });
let fingerprint = '', requestKey = '';
function key(operation: string, payload: unknown) { const next = JSON.stringify([operation,payload]); if (next !== fingerprint) { fingerprint = next; requestKey = crypto.randomUUID(); } return requestKey; }
function adopt(result: MilestoneWriteResult) {
 current.value = result.milestone; workspace.value = { ...workspace.value, planVersion:result.planVersion };
 draft.value = toDraft(result.milestone); delivery.value = copy(result.milestone.delivery); ensureEvidence();
 initialDraft = JSON.stringify(draft.value); initialDelivery = JSON.stringify(delivery.value); reason.value = ''; scopeReason.value = ''; action.value = null; checked.value = []; failed.value = []; stale.value = false; fingerprint = ''; emit('saved');
}
async function execute(operation: () => Promise<MilestoneWriteResult>, message: string) {
 if (busy.value || stale.value) return; busy.value = true; error.value = '';
 try { adopt(await operation()); emit('notify', message); }
 catch (e) { error.value = e instanceof Error ? e.message : '保存失败，请重试。'; if (e instanceof PlanningError && [403,409].includes(e.status)) stale.value = true; }
 finally { busy.value = false; }
}
async function refresh() {
 if (busy.value) return; busy.value = true;
 try { const next = await fetchMilestones(workspace.value.project.id); workspace.value = next; if (current.value) { const updated = next.milestones.find(m => m.id === current.value!.id); if (!updated) throw new Error('该里程碑已不可访问，请返回列表。');
 const previous = current.value;
 const submissionChanged = previous.submissions.at(-1)?.id !== updated.submissions.at(-1)?.id;
 const criteriaChanged = JSON.stringify(previous.criteria) !== JSON.stringify(updated.criteria);
 if (submissionChanged || updated.state === 'submitted' && JSON.stringify(previous.delivery) !== JSON.stringify(updated.delivery)) {
  if (JSON.stringify(delivery.value) !== initialDelivery) recoveredDelivery.value = copy(delivery.value);
  delivery.value = copy(updated.delivery); initialDelivery = JSON.stringify(delivery.value);
  checked.value = []; failed.value = []; action.value = null; reason.value = '';
 } else {
  const allowed = updated.criteria.filter(c => c.kind === 'evidence');
  if (delivery.value.evidence.some(e => !allowed.some(c => c.id === e.criterionId))) recoveredDelivery.value = copy(delivery.value);
  delivery.value.evidence = allowed.map(c => { const retained = delivery.value.evidence.find(e => e.criterionId === c.id); return retained ? {...retained, declared:previous.criteria.find(old => old.id === c.id)?.title === c.title ? retained.declared : false} : {criterionId:c.id,description:'',links:[],declared:false}; });
  if (criteriaChanged) { checked.value = []; failed.value = []; action.value = null; reason.value = ''; }
 }
 current.value = updated; draft.value.date = updated.date; ensureEvidence(); } stale.value = false; error.value = '已读取最新状态。条件与提交版本变化时已清空原核查选择；请重新核对当前成果。未适用的本地文本可在恢复副本中查看。'; fingerprint = ''; }
 catch (e) { error.value = e instanceof Error ? e.message : '重新读取失败，请重试。'; }
 finally { busy.value = false; }
}
async function saveDefinition() {
 if (!manager.value) return;
 if (!draft.value.title.trim() || !draft.value.description.trim() || !draft.value.criteria.length || draft.value.criteria.some(c => !c.title.trim() || c.kind === 'task' && !c.taskId)) { error.value = '请填写名称、交付目标和至少一项完整的必要条件。'; return; }
 if (current.value?.state === 'accepted' && !scopeReason.value.trim()) { error.value = '修改已验收范围需要填写变更依据。'; return; }
 const wasNew = !current.value, selectedDependencies = [...dependencySelection.value];
 const payload = copy(draft.value); payload.date ||= null;
 await execute(() => saveMilestone(workspace.value, props.actorId, payload, key('definition',payload), current.value?.id, current.value?.version, scopeReason.value.trim()), wasNew ? '里程碑已创建。' : '里程碑范围已保存。');
 if (!error.value && current.value) { editing.value = false; if (wasNew) emit('created', current.value.id, selectedDependencies); }
}
async function saveDelivery() {
 if (!current.value || !deliveryEditable.value) return;
 if (!validLinks(delivery.value.links) || delivery.value.evidence.some(e => !validLinks(e.links))) { error.value = '证据链接须以 http:// 或 https:// 开头，每行一条。'; return; }
 await execute(() => saveMilestoneDelivery(workspace.value, props.actorId, current.value!.id, delivery.value, current.value!.version, key('draft', delivery.value)), '交付草稿已保存，可继续补充或提交验收。');
}
function stage(next: MilestoneAction) {
 if (dirty.value) { error.value = '请先保存当前交付草稿，再核对本次操作。'; return; }
 error.value = ''; reason.value = ''; action.value = next; void nextTick(() => dialog.value?.querySelector<HTMLElement>('.ms-confirm')?.scrollIntoView({block:'nearest'}));
}
async function transition() {
 if (!action.value || !current.value) return;
 if (requiredReason.value && !reason.value.trim()) { error.value = selfReview.value ? '管理人员自审须填写自验依据。' : '请填写本次操作依据。'; return; }
 if (action.value === 'accept' && current.value.criteria.some(c => !checked.value.includes(c.id))) { error.value = '请逐项核查并勾选全部必要条件。'; return; }
 if (action.value === 'reject' && !failed.value.length) { error.value = '请至少选择一项未通过条件。'; return; }
 const payload = { expectedVersion:current.value.version, expectedPlanVersion:workspace.value.planVersion, action:action.value, reason:reason.value.trim(), submissionId:latest.value?.id, checkedCriterionIds:checked.value, failedCriterionIds:failed.value };
 await execute(() => transitionMilestone(workspace.value, props.actorId, current.value!.id, payload, key('transition',payload)), `里程碑已${labels[action.value]}，记录已保留。`);
}
function locateGantt() { if (!current.value || !permitLeave()) return; allowNextNavigation = true; const {milestone:_id,...query} = router.currentRoute.value.query; void router.push({name:'plan',params:{projectId:workspace.value.project.id},query:{...query,view:'gantt',task:current.value.id,locate:'milestone',fromMilestone:current.value.id}}); }
function schedule() { if (current.value && permitLeave()) emit('schedule', current.value.id); }
function openTask(id: string) { void router.push({ name:'task-detail', params:{ projectId:workspace.value.project.id, taskId:id } }); }
</script>
<template>
<dialog ref="dialog" class="ms-drawer" aria-label="里程碑详情" @cancel.prevent="close" @click="event => { if (event.target === dialog) close(); }">
 <header class="ms-drawer-head"><div><span class="eyebrow">DELIVERY CHECKPOINT <span v-if="workspace.project.isDemo" class="demo-label">DEMO</span></span><h2>{{ current?.title || '新建里程碑' }}</h2><p>{{ workspace.project.name }} · {{ current?.wbs || '零工期交付节点' }}</p></div><button class="icon-button" aria-label="关闭里程碑详情" :disabled="busy" @click="close">✕</button></header>
 <nav v-if="current && !editing" class="ms-tabs" aria-label="里程碑详情分段"><button v-for="(label,id) in { delivery:'交付与验收', plan:'计划与影响', history:'活动记录' }" :key="id" role="tab" :aria-selected="tab === id" :class="{ active:tab === id }" @click="tab = id">{{ label }}</button></nav>
 <div class="ms-drawer-body">
 <div v-if="error" class="plan-error" role="alert">{{ error }}<button v-if="stale" class="plan-text-button" :disabled="busy" @click="refresh">重新读取里程碑（保留填写内容）</button></div>
 <details v-if="recoveredDelivery" class="ms-condition"><summary>本地交付恢复副本（未提交）</summary><p class="ms-note">条件或提交版本已变化，下列旧文本仅供复制恢复，不会带入当前验收。</p><pre class="ms-recovery">{{ JSON.stringify(recoveredDelivery,null,2) }}</pre></details>
 <form v-if="editing" id="milestone-definition" class="ms-form" @submit.prevent="saveDefinition">
  <p v-if="current?.state === 'cancelled'" class="ms-note">更新责任后可恢复；当前仍为已取消。</p><fieldset :disabled="busy || !manager || stale"><label>里程碑名称<input v-model="draft.title" required maxlength="200" aria-label="里程碑名称"/></label><label>交付目标<textarea v-model="draft.description" required rows="3" maxlength="5000" aria-label="交付目标"></textarea></label>
  <div class="ms-form-grid"><label>所属工作分组<select v-model="draft.workstreamId" required><option v-for="s in workspace.workstreams.filter(s => s.active !== false || s.id === draft.workstreamId)" :key="s.id" :value="s.id">{{ s.name }}{{ s.active === false ? '（已停用）' : '' }}</option></select></label><label>计划日期<input v-model="draft.date" type="date" :disabled="!!current"/><small v-if="current">日期调整使用“计划与影响”中的预览。</small></label><label>负责人<select v-model="draft.ownerId" aria-label="里程碑负责人" required><option value="" disabled>请选择负责人</option><option v-for="a in editableMembers" :key="a.id" :value="a.id">{{ a.name }}</option></select></label><label>验收人<select v-model="draft.reviewerId" aria-label="里程碑验收人" required><option value="" disabled>请选择验收人</option><option v-for="a in editableMembers" :key="a.id" :value="a.id" :disabled="a.id === draft.ownerId && !isProjectManager(a.role)">{{ a.name }}</option></select></label></div>
  <div class="ms-section-title"><h3>必要条件</h3><button type="button" class="plan-text-button" @click="draft.criteria.push({ id:newId(), title:'', kind:'evidence', taskId:null })">＋ 添加条件</button></div><p class="ms-note">所有条件都需就绪，仍须负责人提交、验收人确认。任务关联本身不会改变排期。</p>
  <article v-for="(c,i) in draft.criteria" :key="c.id" class="ms-condition"><div class="ms-section-title"><b>条件 {{ i + 1 }}</b><button type="button" class="plan-text-button" :aria-label="`移除条件 ${i + 1}`" @click="draft.criteria.splice(i,1)">移除</button></div><label>条件名称<input v-model="c.title" :aria-label="`必要条件 ${i + 1}`" required/></label><label>条件类型<select v-model="c.kind" :aria-label="`条件类型 ${i + 1}`" @change="c.taskId = null"><option value="evidence">人工证据</option><option value="task">关联执行任务</option></select></label><template v-if="c.kind === 'task'"><label>关联任务<select v-model="c.taskId" :aria-label="`关联任务 ${i + 1}`" required><option :value="null" disabled>请选择同项目执行任务</option><option v-for="t in tasks" :key="t.id" :value="t.id">{{ t.wbs }} {{ t.title }}</option></select></label><label v-if="!current && c.taskId" class="ms-checkbox"><input v-model="dependencySelection" type="checkbox" :value="c.taskId"/>创建后同时预览设为前置依赖</label></template></article>
  <label v-if="current?.state === 'accepted'">已验收范围变更依据<textarea v-model="scopeReason" required rows="3"></textarea><small>范围变化将使原验收失效，需重新提交；原快照保留。</small></label></fieldset>
 </form>
 <template v-else-if="current">
  <div class="ms-detail-state"><span class="ms-state" :class="`ms-state-${current.state}`">{{ milestoneStateLabels[current.state] }}</span><span>{{ current.owner || '负责人待明确' }} → {{ current.reviewer || '验收人待明确' }}</span></div>
  <template v-if="tab === 'delivery'">
   <p class="ms-description">{{ current.description || '尚未填写交付目标，管理人员可编辑补充。' }}</p><p v-if="current.state === 'legacy_achieved'" class="ms-warning">历史记录缺少正式验收凭证，不计正式达成。请补充条件与成果后提交验收。</p>
   <div class="ms-section-title"><h3>必要条件</h3><span>{{ current.readiness.filter(r => r.ready).length }} / {{ current.criteria.length }} 就绪</span></div>
   <article v-for="(c,i) in current.criteria" :key="c.id" class="ms-condition"><h4>{{ i + 1 }}. {{ c.title }}</h4><p class="ms-note">{{ current.readiness.find(r => r.criterionId === c.id)?.reason || '尚未就绪' }}</p>
    <button v-if="c.kind === 'task' && c.taskId" class="plan-text-button" @click="openTask(c.taskId)">查看关联任务：{{ tasks.find(t => t.id === c.taskId)?.title || c.taskId }} ↗</button>
    <template v-if="c.kind === 'evidence' && deliveryEditable"><label>条件说明<textarea v-model="evidence(c.id).description" :aria-label="`条件说明 ${i + 1}`" :disabled="busy || stale" rows="2"></textarea></label><label>条件证据链接<textarea :value="evidence(c.id).links.join('\n')" :aria-label="`条件证据链接 ${i + 1}`" :disabled="busy || stale" rows="2" placeholder="https://example.com/report（每行一条）" @input="evidence(c.id).links = urls(($event.target as HTMLTextAreaElement).value)"></textarea></label><label class="ms-checkbox"><input v-model="evidence(c.id).declared" type="checkbox" :aria-label="`声明条件 ${i + 1} 已就绪`" :disabled="busy || stale"/>声明本条件已就绪</label></template>
    <template v-else-if="c.kind === 'evidence'"><p class="ms-description">{{ evidence(c.id).description || '尚无条件说明' }}</p><a v-for="link in evidence(c.id).links" :key="link" class="ms-evidence-link" :href="linkSafe(link)" target="_blank" rel="noopener noreferrer">{{ link }}</a></template>
    <div v-if="reviewer" class="ms-review-checks"><label class="ms-checkbox"><input v-model="checked" :value="c.id" type="checkbox" :aria-label="`核查通过 ${c.title}`" :disabled="busy" @change="failed = failed.filter(id => id !== c.id)"/>核查通过</label><label class="ms-checkbox"><input v-model="failed" :value="c.id" type="checkbox" :aria-label="`未通过 ${c.title}`" :disabled="busy" @change="checked = checked.filter(id => id !== c.id)"/>未通过</label></div>
   </article><p v-if="!current.criteria.length" class="ms-note">尚无必要条件。管理人员需先编辑里程碑补充条件。</p>
   <div class="ms-section-title"><h3>本次交付成果</h3><span v-if="latest">第 {{ current.submissions.length }} 次提交</span></div>
   <template v-if="deliveryEditable"><label>整体成果说明<textarea v-model="delivery.summary" aria-label="整体成果说明" :disabled="busy || stale" rows="4"></textarea></label><label>整体证据链接<textarea :value="delivery.links.join('\n')" aria-label="整体证据链接" :disabled="busy || stale" rows="2" placeholder="HTTP(S) 链接，每行一条" @input="delivery.links = urls(($event.target as HTMLTextAreaElement).value)"></textarea></label></template>
   <template v-else><p class="ms-description">{{ current.delivery.summary || '尚未填写整体成果。' }}</p><a v-for="link in current.delivery.links" :key="link" class="ms-evidence-link" :href="linkSafe(link)" target="_blank" rel="noopener noreferrer">{{ link }}</a></template>
   <p v-if="current.missing.length && deliveryEditable" class="ms-note">提交前还需：{{ current.missing.join('；') }}</p>
   <p v-if="!writable" class="ms-note">当前为只读身份，可查看交付与历史记录。</p>
  </template>
  <template v-if="tab === 'plan'"><dl class="ms-facts"><div><dt>当前计划日期</dt><dd>{{ current.date || '待排期' }}</dd></div><div><dt>预测日期</dt><dd>{{ current.forecast.date || '未知' }}</dd></div><div><dt>实际验收日期</dt><dd>{{ current.acceptedAt ? time(current.acceptedAt) : '尚无正式验收' }}</dd></div><div><dt>计划投入</dt><dd>零工期 · 不占工时</dd></div></dl><p class="ms-note">{{ current.forecast.explanation }}</p><div class="ms-actions"><button class="button" @click="locateGantt">定位到甘特图</button><button class="button" @click="schedule">{{ manager ? '预览日期与依赖调整' : '查看日期与依赖' }}</button></div><h3>后续影响</h3><p class="ms-note">{{ successors.length ? `直接后续：${successors.join('、')}` : '暂无直接后续依赖。' }}取消、重开或成果失效可能使后续条件不再满足。</p><h3>基线承诺</h3><p v-for="b in workspace.baselines" :key="b.id" class="ms-note">{{ b.name }}：{{ b.entries.find(e => e.taskId === current!.id)?.end || '未纳入该基线' }}</p><p v-if="!workspace.baselines.length" class="ms-note">暂无已发布基线，不能比较承诺偏差。</p></template>
  <template v-if="tab === 'history'"><h3>提交与验收快照</h3><details v-for="(s,i) in [...current.submissions].reverse()" :key="s.id" class="ms-condition"><summary>第 {{ current.submissions.length - i }} 次提交 · {{ time(s.createdAt) }}{{ s.invalidatedAt ? ' · 已失效' : '' }}</summary><h4>{{ s.snapshot.title }}</h4><p class="ms-description">{{ s.snapshot.description }}</p><p>提交人：{{ workspace.actors.find(a => a.id === s.submitterId)?.name || s.submitterId }}</p><p class="ms-description">{{ s.snapshot.summary }}</p><a v-for="link in s.snapshot.links" :key="link" class="ms-evidence-link" :href="linkSafe(link)" target="_blank" rel="noopener noreferrer">{{ link }}</a><article v-for="c in s.snapshot.criteria" :key="c.id" class="ms-snapshot-condition"><b>{{ c.title }}</b><p>{{ s.snapshot.evidence.find(e => e.criterionId === c.id)?.description || (c.taskId ? `关联任务：${c.taskId}` : '无补充说明') }}</p><a v-for="link in s.snapshot.evidence.find(e => e.criterionId === c.id)?.links || []" :key="link" class="ms-evidence-link" :href="linkSafe(link)" target="_blank" rel="noopener noreferrer">{{ link }}</a></article><p v-for="r in s.reviews" :key="r.id" class="ms-note">{{ r.decision === 'accept' ? '验收通过' : '退回修改' }} · {{ r.actor }}{{ r.selfReview ? ' · 管理人员自审' : '' }} · {{ time(r.createdAt) }}<br/>{{ r.comment || '未填写补充意见' }}<br/>{{ r.failedCriterionIds.length ? `未通过条件：${r.failedCriterionIds.map(id => s.snapshot.criteria.find(c => c.id === id)?.title || id).join('、')}` : '' }}</p></details><p v-if="!current.submissions.length" class="ms-note">尚无提交快照；首次提交后会保留本版条件和成果。</p><h3>活动记录</h3><article v-for="event in [...current.events].reverse()" :key="event.id" class="ms-event"><b>{{ event.text }}</b><small>{{ event.actor }} · {{ time(event.createdAt) }}</small></article></template>
  <section v-if="action" class="ms-confirm" aria-live="polite"><h3>{{ labels[action] }}</h3><p><b>{{ current.title }}</b> · {{ actor?.name }} · 版本 {{ current.version }}</p><p>{{ actionNote[action] }}</p><p v-if="['cancel','reopen','restore'].includes(action)">直接后续 {{ successors.length }} 项：{{ successors.join('、') || '无' }}。最终影响由服务端重新核验并留痕。</p><p v-if="action === 'submit'">接收人：{{ current.reviewer }}；{{ current.criteria.length }} 项必要条件，整体成果及 {{ current.delivery.links.length }} 条证据链接。</p><p v-if="action === 'reject'">未通过：{{ current.criteria.filter(c => failed.includes(c.id)).map(c => c.title).join('、') || '请先选择至少一个未通过条件' }}</p><label v-if="requiredReason || ['accept','reject'].includes(action)">{{ selfReview ? '自验依据（必填）' : requiredReason ? '操作依据（必填）' : '验收意见（选填）' }}<textarea v-model="reason" rows="3" :disabled="busy" :required="requiredReason"></textarea></label><div class="ms-actions"><button class="button" :disabled="busy" @click="action = null; reason = ''">取消本次操作</button><button class="button primary" :disabled="busy || stale" @click="transition">{{ busy ? '正在处理…' : `确认${labels[action]}` }}</button></div></section>
 </template>
 </div>
 <footer class="ms-drawer-footer"><template v-if="editing"><button class="button" :disabled="busy" @click="current ? (permitLeave() && (editing = false, draft = toDraft(current), scopeReason = '')) : close()">取消</button><button class="button primary" form="milestone-definition" :disabled="busy || stale || !manager">{{ busy ? '正在保存…' : current ? '保存里程碑修改' : '创建里程碑' }}</button></template><template v-else-if="current && !action"><button v-if="manager && current.state !== 'submitted'" class="button" :disabled="busy" @click="editing = true">编辑里程碑</button><template v-if="deliveryEditable && tab === 'delivery'"><button class="button" :disabled="busy || stale" @click="saveDelivery">{{ busy ? '正在保存…' : '保存交付草稿' }}</button><button class="button primary" :disabled="busy || stale || !current.canSubmit || dirty" @click="stage('submit')">提交验收</button></template><template v-if="reviewer && tab === 'delivery'"><button class="button" :disabled="busy" @click="stage('reject')">退回修改</button><button class="button primary" :disabled="busy" @click="stage('accept')">验收通过</button></template><button v-if="current.state === 'submitted' && writable && (manager || latest?.submitterId === actorId)" class="button" :disabled="busy" @click="stage('withdraw')">撤回提交</button><template v-if="manager"><button v-if="current.state === 'cancelled'" class="button" :disabled="busy" @click="stage('restore')">恢复里程碑</button><button v-else-if="current.state === 'accepted'" class="button" :disabled="busy" @click="stage('reopen')">重开里程碑</button><button v-if="current.state !== 'cancelled'" class="plan-text-button" :disabled="busy" @click="stage('cancel')">取消里程碑</button></template></template><span v-else-if="action" class="ms-note">请在上方核对操作范围与依据。</span></footer>
</dialog>
</template>
