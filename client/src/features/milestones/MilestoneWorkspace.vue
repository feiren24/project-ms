<script lang="ts">
import { useProjectView } from '../../stores/project-scope';
const defaults = () => ({ query:'', workstream:'', owner:'', state:'', date:'', baseline:'', scope:'all' });
</script>
<script setup lang="ts">
import { computed, ref, nextTick, onMounted, onBeforeUnmount, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { fetchMilestones } from '../../api/milestones';
import { fetchPlan } from '../../api/planning';
import { useAuthStore } from '../../stores/auth';
import { useProjectRefresh } from '../../stores/useProjectRefresh';
import { currentProjectId } from '../../stores/project-scope';
import { isProjectManager, canWriteProject, canReviewTask } from '../../../../shared/src/permissions';
import { milestoneStateLabels, type MilestoneWorkspace, type Milestone } from '../../../../shared/src/milestones';
import type { ProjectPlan, PlanNode } from '../../../../shared/src/planning';
import { verifyProjectExportAccess } from '../../utils/project-permissions';
import { projectCsvFilename } from '../../utils/project-presentation';
import MilestoneDrawer from './MilestoneDrawer.vue';
import PlanChangeDialog from '../gantt/PlanChangeDialog.vue';
import { milestoneWorkdayDifference, milestoneForecastIsLate } from './metrics';
import './milestones.css';
const props = defineProps<{ planFilters: {query:string;workstream:string;owner:string;baselineId:string} }>();
const emit = defineEmits<{ 'overview-changed': []; notify: [message: string] }>();
const auth = useAuthStore(), collaboration = useProjectRefresh(), route = useRoute(), router = useRouter();
const projectId = currentProjectId(), view = useProjectView('milestones', defaults);
const workspace = ref<MilestoneWorkspace|null>(null), loading = ref(true), error = ref(''), exporting = ref(false);
watch(() => [props.planFilters.query,props.planFilters.workstream,props.planFilters.owner,props.planFilters.baselineId], ([query,workstream,owner,baseline]) => { Object.assign(view,{query,workstream,owner,baseline}); }, {immediate:true});
watch(() => [view.query,view.workstream,view.owner,view.baseline], ([query,workstream,owner,baseline]) => { Object.assign(props.planFilters,{query,workstream,owner,baselineId:baseline}); });
const actorId = computed({ get:() => auth.session?.legacyDemo ? collaboration.actorId.value : auth.actorForProject(projectId), set:(value: string) => { collaboration.actorId.value = value; } });
const actor = computed(() => workspace.value?.actors.find(a => a.id === actorId.value));
const manager = computed(() => isProjectManager(actor.value?.role));
const writable = computed(() => canWriteProject(actor.value?.role));
const selectedId = computed(() => typeof route.query.milestone === 'string' ? route.query.milestone : '');
const selected = computed(() => workspace.value?.milestones.find(m => m.id === selectedId.value) || null);
const isNew = computed(() => selectedId.value === 'new');
const filterDialog = ref<HTMLDialogElement>(), filterOpen = ref(false);
const filterDraft = ref({workstream:'',owner:'',state:'',date:'',baseline:''});
const filterCount = computed(() => [view.workstream,view.owner,view.state,view.date,view.baseline].filter(Boolean).length);
let filterTrigger: HTMLElement | null = null;
async function openFilters() { filterTrigger = document.activeElement as HTMLElement; filterDraft.value = {workstream:view.workstream,owner:view.owner,state:view.state,date:view.date,baseline:view.baseline}; filterOpen.value = true; await nextTick(); filterDialog.value?.showModal(); }
function closeFilters() { filterDialog.value?.close(); filterOpen.value = false; void nextTick(() => filterTrigger?.isConnected && filterTrigger.focus()); }
function applyFilters() { Object.assign(view,filterDraft.value); closeFilters(); }
function clearFilterDraft() { filterDraft.value = {workstream:'',owner:'',state:'',date:'',baseline:''}; }
const schedule = ref<{ plan:ProjectPlan; node:PlanNode; dependencies?:string[] }|null>(null);
let disposed = false;
const active = computed(() => workspace.value?.milestones.filter(m => m.state !== 'cancelled') || []);
const day = (s: string) => Date.parse(`${s.slice(0,10)}T00:00:00Z`);
const overdue = (m: Milestone) => !!m.date && m.state !== 'accepted' && m.state !== 'cancelled' && m.date < (workspace.value?.project.asOf || '');
const due = (m: Milestone) => !!m.date && !['accepted','cancelled'].includes(m.state) && day(m.date) >= day(workspace.value!.project.asOf) && day(m.date) - day(workspace.value!.project.asOf) <= 14*86400000;
const warning = (m: Milestone) => overdue(m) || m.state === 'needs_review' || milestoneForecastIsLate(m.forecast.date,commitment(m),m.date);
const forecastReference = (m: Milestone) => commitment(m) ? `基线承诺 ${commitment(m)}` : `当前计划 ${m.date || '待排期'}`;
const toReview = (m: Milestone) => m.state === 'submitted' && canReviewTask(actor.value?.role, actorId.value, m.ownerId, m.submissions.at(-1)?.submitterId || '', m.reviewerId);
const accepted = computed(() => active.value.filter(m => m.state === 'accepted').length);
const baseline = computed(() => workspace.value?.baselines.find(b => b.id === view.baseline));
function commitment(m: Milestone) { return baseline.value?.entries.find(e => e.taskId === m.id)?.end || null; }
const shanghaiDate = (value: string) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
function deviation(m: Milestone) { const before = commitment(m); if (!baseline.value) return '未选择基线'; if (!before) return '未纳入基线'; const date = m.state === 'accepted' && m.acceptedAt ? shanghaiDate(m.acceptedAt) : m.date; if (!date) return '当前待排期'; const delta = milestoneWorkdayDifference(before,date,workspace.value!.calendar); return (m.state === 'accepted' ? '实际 ' : '') + (delta === 0 ? '与承诺一致' : `${delta > 0 ? '延后' : '提前'} ${Math.abs(delta)} 工作日`); }
const filtered = computed(() => workspace.value?.milestones.filter(m => (m.state !== 'cancelled' || view.state === 'cancelled') && (!view.query.trim() || `${m.title} ${m.description} ${m.owner} ${m.wbs}`.toLowerCase().includes(view.query.trim().toLowerCase())) && (!view.workstream || m.workstreamId === view.workstream) && (!view.owner || m.owner === view.owner) && (!view.state || m.state === view.state) && (view.scope === 'all' || view.scope === 'mine' && m.ownerId === actorId.value || view.scope === 'review' && toReview(m) || view.scope === 'due' && due(m) || view.scope === 'warning' && warning(m) || view.scope === 'accepted' && m.state === 'accepted') && (!view.date || view.date === 'unplanned' && !m.date || view.date === 'overdue' && overdue(m) || view.date === 'upcoming' && due(m) || view.date === 'changed' && !!commitment(m) && commitment(m) !== m.date) && (!route.query.task || m.criteria.some(c => c.taskId === route.query.task))).sort((a,b) => a.date && b.date ? a.date.localeCompare(b.date) || a.wbs.localeCompare(b.wbs,undefined,{numeric:true}) : a.date ? -1 : b.date ? 1 : a.wbs.localeCompare(b.wbs,undefined,{numeric:true})) || []);
async function load() {
 if (disposed) return false; loading.value = true; error.value = '';
 try { const result = await fetchMilestones(projectId); if (disposed) return false; workspace.value = result; return true; }
 catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '里程碑读取失败，请重试。'; return false; }
 finally { if (!disposed) loading.value = false; }
}
function open(id: string) { void router.push({ path:route.path, query:{ ...route.query, view:'milestones', milestone:id } }); }
function close() { const { milestone:_id, ...query } = route.query; void router.replace({ path:route.path, query }); }
async function changed() { await load(); emit('overview-changed'); }
async function created(id: string, dependencies: string[]) { await load(); const result = await router.replace({path:route.path,query:{...route.query,view:'milestones',milestone:id}}); if (!result && dependencies.length) await openSchedule(id,dependencies); }
async function openSchedule(id: string, dependencies?: string[]) {
 loading.value = true;
 try { const plan = await fetchPlan(projectId); if (disposed) return; const node = plan.nodes.find(n => n.id === id); if (!node) throw new Error('计划中已找不到该里程碑，请重新读取。'); schedule.value = { plan, node, dependencies }; }
 catch (e) { emit('notify', e instanceof Error ? e.message : '排期无法读取，请重试。'); }
 finally { loading.value = false; }
}
function clearFilters() { view.query = ''; view.workstream = ''; view.owner = ''; view.state = ''; view.date = ''; view.scope = 'all'; if (route.query.task) { const { task:_task, ...query } = route.query; void router.replace({ path:route.path, query }); } }
async function exportCsv() {
 if (!workspace.value || !writable.value || exporting.value) return; exporting.value = true;
 try { await verifyProjectExportAccess(projectId); if (disposed) return; const w = await fetchMilestones(projectId); if (!canWriteProject(w.actors.find(a => a.id === actorId.value)?.role)) throw new Error('当前身份已无导出权限。'); workspace.value = w;
 const quote = (v: unknown) => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"','""')}"`; };
 const rows = [['WBS','里程碑','负责人','验收人','当前计划','基线承诺','承诺偏差','预测日期','预测说明','验收状态','就绪条件','实际验收','数据性质'], ...filtered.value.map(m => [m.wbs,m.title,m.owner,m.reviewer,m.date,commitment(m),deviation(m),m.forecast.date,m.forecast.explanation,milestoneStateLabels[m.state],`${m.readiness.filter(r => r.ready).length}/${m.criteria.length}`,m.acceptedAt,w.project.isDemo ? 'DEMO' : '项目数据'])];
 const url = URL.createObjectURL(new Blob(['\uFEFF'+rows.map(r => r.map(quote).join(',')).join('\r\n')], {type:'text/csv;charset=utf-8'})); const a = document.createElement('a'); a.href = url; a.download = projectCsvFilename(w.project,'里程碑'); a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); emit('notify',`已导出当前筛选的 ${filtered.value.length} 个里程碑。`);
 } catch (e) { emit('notify',e instanceof Error ? e.message : '导出失败，请重试。'); } finally { exporting.value = false; }
}
watch(actorId, () => { if (!selectedId.value) void load(); });
onMounted(load); onBeforeUnmount(() => { disposed = true; filterDialog.value?.close(); });
defineExpose({ refreshForCollaboration: async () => { if (selectedId.value || schedule.value) { emit('notify','请先完成当前里程碑编辑，填写内容已保留。'); return false; } return load(); } });
</script>
<template>
<section class="ms-workspace" aria-labelledby="milestones-title">
 <div class="ms-workspace-heading"><div><h2 id="milestones-title" aria-label="里程碑交付">里程碑交付 <span class="ms-count">{{ active.length }}</span></h2><p>条件就绪 → 提交成果 → 独立验收，留下每一次交付依据。</p></div><div class="ms-actions"><button v-if="writable" class="button" :disabled="loading || exporting" @click="exportCsv">{{ exporting ? '正在导出…' : '导出里程碑' }}</button><button v-if="manager" class="button primary" :disabled="loading" @click="open('new')">新建里程碑</button></div></div>
 <p v-if="loading" class="ms-note" role="status">正在读取里程碑与交付状态…</p><div v-if="error" class="plan-error" role="alert">{{ error }}<button class="plan-text-button" @click="load">重新读取里程碑</button></div>
 <template v-if="workspace"><div v-if="workspace.project.isDemo" class="ms-demo"><span class="demo-label">DEMO</span>示例项目 · {{ workspace.project.asOf }} 快照口径，模拟交付不代表真实业务结果。</div>
 <div class="ms-metrics"><button @click="view.scope = 'due'"><span>临近到期</span><b>{{ active.filter(due).length }}<small>个</small></b><em>未来 14 天的交付节点</em></button><button @click="view.scope = 'warning'"><span>交付预警</span><b class="orange-text">{{ active.filter(warning).length }}<small>个</small></b><em>逾期、预测延期或需复核</em></button><button @click="view.scope = 'review'"><span>待我验收</span><b>{{ active.filter(toReview).length }}<small>个</small></b><em>核查条件，确认交付</em></button><button @click="view.scope = 'accepted'"><span>已验收</span><b>{{ accepted }}<small>/ {{ active.length }}</small></b><em>达成率 {{ active.length ? Math.round(accepted / active.length * 100)+'%' : '—' }}</em></button></div>
 <div class="ms-board"><div class="ms-list-toolbar"><nav class="ms-tabs" aria-label="里程碑范围"><button v-for="(label,id) in {all:'全部',mine:'我负责',review:'待我验收'}" :key="id" :aria-pressed="view.scope === id" :class="{active:view.scope === id}" @click="view.scope = id">{{ label }}</button></nav><label v-if="auth.session?.legacyDemo" class="ms-identity">体验身份<select v-model="actorId" aria-label="里程碑体验身份" :disabled="!!selectedId"><option v-for="a in workspace.actors" :key="a.id" :value="a.id">{{ a.name }} · {{ isProjectManager(a.role) ? '管理人员' : a.role === 'viewer' ? '只读成员' : '项目成员' }}</option></select></label><span v-else class="ms-note">当前身份：{{ actor?.name || '只读访问' }}</span></div>
 <div class="ms-mobile-filter-row"><input v-model="view.query" aria-label="手机搜索里程碑" placeholder="搜索里程碑、负责人或 WBS"/><button class="button" :aria-expanded="filterOpen" aria-haspopup="dialog" @click="openFilters">筛选<span v-if="filterCount" class="ms-filter-count">{{ filterCount }}</span></button></div>
 <div class="ms-filters ms-desktop-filters"><input v-model="view.query" aria-label="搜索里程碑" placeholder="搜索里程碑、负责人或 WBS"/><select v-model="view.workstream" aria-label="里程碑工作分组筛选"><option value="">全部工作分组</option><option v-for="s in workspace.workstreams" :key="s.id" :value="s.id">{{ s.name }}</option></select><select v-model="view.owner" aria-label="里程碑负责人筛选"><option value="">全部负责人</option><option v-for="a in workspace.actors" :key="a.id" :value="a.name">{{ a.name }}</option></select><select v-model="view.state" aria-label="里程碑状态筛选"><option value="">全部验收状态</option><option v-for="(label,id) in milestoneStateLabels" :key="id" :value="id">{{ label }}</option></select><select v-model="view.date" aria-label="里程碑计划日期筛选"><option value="">全部计划日期</option><option value="upcoming">14 天内到期</option><option value="overdue">已逾期</option><option value="unplanned">待排期</option><option value="changed">偏离基线</option></select><select v-model="view.baseline" aria-label="里程碑对比基线"><option value="">选择对比基线</option><option v-for="b in workspace.baselines" :key="b.id" :value="b.id">{{ b.name }}</option></select></div>
 <div class="ms-result"><span>共 {{ filtered.length }} 个节点{{ route.query.task ? ' · 关联当前任务' : '' }}{{ ['due','warning','accepted'].includes(view.scope) ? ' · 已应用指标筛选' : '' }}</span><button class="plan-text-button" @click="clearFilters">重置筛选</button></div>
 <div class="ms-table-head"><span>交付节点 / 负责人</span><span>当前计划 / 预测</span><span>基线承诺 / 偏差</span><span>条件就绪</span><span>验收状态</span></div>
 <template v-for="(m,index) in filtered" :key="m.id"><div v-if="!m.date && (index === 0 || filtered[index - 1]?.date)" class="ms-unscheduled-group">待排期节点 · 先明确日期，再比较承诺偏差</div><button class="ms-row" :aria-label="`查看里程碑 ${m.title}`" @click="open(m.id)"><span class="ms-row-title"><small>{{ m.wbs }} · {{ workspace.workstreams.find(s => s.id === m.workstreamId)?.name || '未分组' }}</small><strong><span class="ms-diamond">◆</span>{{ m.title }}</strong><small>{{ m.owner || '负责人待明确' }} → {{ m.reviewer || '验收人待明确' }}</small></span><span class="ms-row-date"><b>{{ m.date || '待排期' }}</b><small :class="{ 'orange-text':warning(m) }">{{ overdue(m) ? '已逾期 · ' : '' }}预测 {{ m.forecast.date || '未知' }}</small><small v-if="m.forecast.date">参照{{ forecastReference(m) }}</small></span><span class="ms-row-baseline"><b>{{ commitment(m) || '暂无承诺' }}</b><small>{{ deviation(m) }}</small></span><span class="ms-row-ready"><b>{{ m.readiness.filter(r => r.ready).length }} / {{ m.criteria.length }}</b><progress :value="m.readiness.filter(r => r.ready).length" :max="m.criteria.length || 1"></progress><small>{{ m.criteria.length ? '条件就绪' : '待补充条件' }}</small></span><span class="ms-row-status"><span class="ms-state" :class="`ms-state-${m.state}`">{{ milestoneStateLabels[m.state] }}</span><small v-if="m.acceptedAt">{{ shanghaiDate(m.acceptedAt) }}</small><small v-if="warning(m)" class="orange-text">交付预警</small></span></button></template>
 <div v-if="!filtered.length && !loading" class="ms-empty"><h3>{{ workspace.milestones.length ? '没有符合条件的里程碑' : '把关键交付设为里程碑' }}</h3><p>{{ workspace.milestones.length ? '调整搜索或筛选条件，查看其他交付节点。' : '管理人员创建节点并明确负责人、验收人与必要条件后，即可开始交付。' }}</p><button class="button" @click="workspace.milestones.length ? clearFilters() : manager ? open('new') : load()">{{ workspace.milestones.length ? '清除筛选' : manager ? '新建里程碑' : '重新读取' }}</button></div></div>
 <p class="ms-footnote">里程碑为零工期节点，不占工时、不计普通任务分母。条件就绪不等于已验收；历史无凭证达成不计正式达成率。</p>
 <dialog v-if="filterOpen" ref="filterDialog" class="ms-filter-sheet" aria-labelledby="milestone-filter-title" @cancel.prevent="closeFilters" @click="event => { if (event.target === filterDialog) closeFilters(); }">
  <header><div><span class="eyebrow">FILTER CHECKPOINTS</span><h2 id="milestone-filter-title">里程碑筛选</h2></div><button class="icon-button" aria-label="关闭里程碑筛选" @click="closeFilters">✕</button></header>
  <form @submit.prevent="applyFilters"><div class="ms-filter-sheet-body"><p class="ms-note">筛选当前项目的交付节点，应用后返回原列表。</p>
   <label>工作分组<select v-model="filterDraft.workstream" aria-label="筛选里程碑工作分组"><option value="">全部工作分组</option><option v-for="s in workspace.workstreams" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
   <label>负责人<select v-model="filterDraft.owner" aria-label="筛选里程碑负责人"><option value="">全部负责人</option><option v-for="a in workspace.actors" :key="a.id" :value="a.name">{{ a.name }}</option></select></label>
   <label>验收状态<select v-model="filterDraft.state" aria-label="筛选里程碑验收状态"><option value="">全部验收状态</option><option v-for="(label,id) in milestoneStateLabels" :key="id" :value="id">{{ label }}</option></select></label>
   <label>计划日期<select v-model="filterDraft.date" aria-label="筛选里程碑计划日期"><option value="">全部计划日期</option><option value="upcoming">14 天内到期</option><option value="overdue">已逾期</option><option value="unplanned">待排期</option><option value="changed">偏离基线</option></select></label>
   <label>对比基线<select v-model="filterDraft.baseline" aria-label="筛选里程碑对比基线"><option value="">不比较基线</option><option v-for="b in workspace.baselines" :key="b.id" :value="b.id">{{ b.name }}</option></select></label>
  </div><footer><button type="button" class="button" @click="clearFilterDraft">清空筛选</button><button type="submit" class="button primary">应用筛选</button></footer></form>
 </dialog>
 <MilestoneDrawer v-if="(selected || isNew) && !schedule" :key="selectedId" :workspace="workspace" :milestone="selected" :actor-id="actorId" @close="close" @saved="changed" @notify="emit('notify',$event)" @schedule="openSchedule" @created="created"/>
 <div v-else-if="selectedId && !schedule && !loading" class="plan-error" role="alert">找不到该里程碑，可能已移除或不属于当前项目。<button class="plan-text-button" @click="close">返回里程碑列表</button></div>
 <PlanChangeDialog v-if="schedule" :plan="schedule.plan" :node="schedule.node" :initial-dependencies="schedule.dependencies" :read-only="!manager" @close="schedule = null" @saved="async message => { schedule = null; await changed(); emit('notify',message); }" @stale="async () => { if (schedule) schedule.plan = await fetchPlan(projectId); }"/>
 </template>
</section>
</template>
