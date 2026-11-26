<script lang="ts">
import { useProjectView, currentProjectId } from '../../stores/project-scope';
const defaultView = () => ({ panel: 'gantt' as 'gantt'|'milestones', query: '', workstream: '', owner: '', status: '', zoom: 'month' as 'day'|'week'|'month', collapsed: [] as string[], critical: false, baselineId: '', mobileView: 'list', initialized: false, fit: true });
</script>
<script setup lang="ts">
import { verifyProjectExportAccess } from '../../utils/project-permissions';
import { isProjectManager, canWriteProject } from '../../../../shared/src/permissions';

import { calendarDescription, projectCsvFilename } from '../../utils/project-presentation';
import { useAuthStore } from '../../stores/auth';
import { useProjectRefresh } from '../../stores/useProjectRefresh';
import { RouterLink, useRoute, useRouter, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import MilestoneWorkspace from '../milestones/MilestoneWorkspace.vue';
import PlanTaskDetailHost from '../tasks/PlanTaskDetailHost.vue';
import { computed, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import Icon from '../../components/Icon.vue';
import GanttCanvas from './GanttCanvas.vue';
import PlanTreeLines from './PlanTreeLines.vue';
import { buildPlanTree } from './plan-tree';
import PlanChangeDialog from './PlanChangeDialog.vue';
import BaselineDialog from './BaselineDialog.vue';
import PlanOrderControls from './PlanOrderControls.vue';
import OrderSequence from './OrderSequence.vue';
import { usePlanOrder } from './usePlanOrder';
import { fetchPlanHistory, fetchPlan, PlanningError } from '../../api/planning';
import { fetchProject } from '../../api/projects';
import type { PlanNode, ProjectPlan } from '../../../../shared/src/planning';
import './plan-page.css';
import './plan-workspace.css';
import './plan-tree.css';
import OrderDialog from './OrderDialog.vue';
import PlanFilters from './PlanFilters.vue';
import PlanChecks from './PlanChecks.vue';
import { usePlanViewport } from './usePlanViewport';
const view = useProjectView('plan', defaultView);
const pageProjectId = currentProjectId();
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const route = useRoute(), router = useRouter();
const milestoneView = computed(() => route.query.view === 'gantt' ? false : route.query.view === 'milestones' || !!route.query.milestone || view.panel === 'milestones');
watch(() => [route.query.view,route.query.milestone], () => { if (route.query.view === 'gantt') view.panel = 'gantt'; else if (route.query.view === 'milestones' || route.query.milestone) view.panel = 'milestones'; }, {immediate:true});
const milestonePage = ref<InstanceType<typeof MilestoneWorkspace>>();
function switchPlanView(view: string) { const { milestone: _milestone, task: _task, taskTab: _taskTab, ...query } = route.query; void router.push({ path:route.path, query:{ ...query, view } }); }
const auth = useAuthStore();
const collaboration = useProjectRefresh();
const projectRole = ref(auth.session?.projects.find(p=>p.id===pageProjectId)?.role);
const exporting = ref(false);
const canExport = computed(() => !!auth.session?.legacyDemo || canWriteProject(auth.session?.projects.find(p => p.id === pageProjectId)?.role));
const canPlan = computed(() => Boolean(auth.session?.legacyDemo) || (!!auth.actorForProject(pageProjectId) && isProjectManager(projectRole.value)));
const emit = defineEmits<{ 'overview-changed': []; notify: [message: string] }>();
const plan = ref<ProjectPlan | null>(null), loading = ref(true), error = ref('');
const canvas = ref<InstanceType<typeof GanttCanvas>>(), page = ref<HTMLElement>();
// selected is reserved for readonly workstream/range-gap details.
const selected = ref<PlanNode | null>(null), proposal = ref<{ taskId: string; start: string; end: string }>();
const taskHost = ref<InstanceType<typeof PlanTaskDetailHost>>();
const actorId = computed(() => auth.session?.legacyDemo ? collaboration.actorId.value : auth.actorForProject(pageProjectId));
const canEditSchedule = computed(() => plan.value?.canEditSchedule === true);
function isActualTask(node: PlanNode) {
  if (node.kind === 'milestone' || node.kind === 'gap') return false;
  const marker = node.taskKind;
  return marker === 'execution' || marker === 'summary' || node.kind === 'task'
    || (node.kind === 'group' && !!node.parentId && node.id !== `group-${node.workstreamId}`);
}
const linkedNode = computed(() => plan.value?.nodes.find(node => node.id === route.query.task));
const detailTaskId = computed(() => !milestoneView.value && route.query.locate !== 'milestone' && typeof route.query.task === 'string'
  && plan.value && (!linkedNode.value || isActualTask(linkedNode.value)) ? route.query.task : '');
let handledNavigation = false;
async function navigateHandled(location: Parameters<typeof router.push>[0], replace = false) {
  handledNavigation = true;
  try { return await (replace ? router.replace(location) : router.push(location)); }
  finally { handledNavigation = false; }
}
async function protectNavigation() { return await taskHost.value?.confirmNavigation() ?? true; }
onBeforeRouteLeave(() => handledNavigation ? true : protectNavigation());
onBeforeRouteUpdate(() => handledNavigation ? true : protectNavigation());
function taskLocation(id: string, tab: 'detail'|'plan' = 'detail') {
  const { taskTab: _tab, milestone: _milestone, locate: _locate, fromMilestone: _from, ...query } = route.query;
  return { path: route.path, query: { ...query, view: 'gantt', task: id, ...(tab === 'plan' ? { taskTab: 'plan' } : {}) } };
}
function openRelatedTask(id: string) { proposal.value = undefined; void navigateHandled(taskLocation(id)); }
function showTaskPlan(id: string) { proposal.value = undefined; void navigateHandled(taskLocation(id, 'plan')); }
function closeTask() {
  selected.value = null; proposal.value = undefined;
  const { task: _task, taskTab: _tab, ...query } = route.query;
  if (_task || _tab) void navigateHandled({ path: route.path, query }, true);
}
async function taskChanged() { await load(); if (!disposed) emit('overview-changed'); }
watch(() => [route.query.task, route.query.taskTab, route.query.view, plan.value] as const, () => {
  if (proposal.value && (proposal.value.taskId !== detailTaskId.value || route.query.taskTab !== 'plan')) proposal.value = undefined;
  selected.value = null;
  if (milestoneView.value || route.query.locate === 'milestone' || !linkedNode.value) return;
  if (linkedNode.value.kind === 'milestone') { select(linkedNode.value); return; }
  if (!isActualTask(linkedNode.value)) selected.value = linkedNode.value;
});
const baselineOpen = ref(false), issuesOpen = ref(false), info = ref<'history'|'differences'|null>(null), infoDialog = ref<HTMLDialogElement>();
const fullscreen = ref(false);
const popup = ref<'filters'|'more'|'legend'|'about'|'zoom'|null>(null);
const { availableHeight } = usePlanViewport(page, fullscreen);
const checksModal = computed(() => mobile.value || availableHeight.value < 650);
const filterCount = computed(() => [view.workstream, view.owner, view.status].filter(Boolean).length);
function closeChecks() { issuesOpen.value = false; void nextTick(() => page.value?.querySelector<HTMLElement>('.plan-check-trigger')?.focus({ preventScroll: true })); }
function selectFromChecks(node: PlanNode) { closeChecks(); select(node); }
const mobile = ref(window.matchMedia('(max-width: 767px)').matches), mobileLimit = ref(50);
const mobileMedia = window.matchMedia('(max-width: 767px)');
const resizeMobile = () => { mobile.value = mobileMedia.matches; };
onMounted(() => mobileMedia.addEventListener('change',resizeMobile));
onBeforeUnmount(() => mobileMedia.removeEventListener('change',resizeMobile));
const order = usePlanOrder(plan, canPlan, view, {
  mobile, actorId: () => auth.session?.legacyDemo ? collaboration.actorId.value : auth.actorForProject(pageProjectId),
  readLatest: async () => {
    const [result, access] = await Promise.all([fetchPlan(pageProjectId, actorId.value), auth.session?.legacyDemo ? Promise.resolve(null) : fetchProject(pageProjectId)]);
    if (access) projectRole.value = access.role;
    return result;
  },
  notify: message => emit('notify', message), changed: () => emit('overview-changed'),
  locate: id => { const index = visibleRows.value.findIndex(node => node.id === id); if (index < 0) return; mobileLimit.value = Math.max(mobileLimit.value, index + 1); void nextTick(() => { if (mobile.value) page.value?.querySelector<HTMLElement>(`[data-order-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' }); else canvas.value?.locateRow(id); }); },
});
const orderedNodes = computed(() => order.nodes);
const groups = computed(() => orderedNodes.value.filter(n => n.kind === 'group' && !n.parentId));
const leaves = computed(() => orderedNodes.value.filter(n => n.kind !== 'group'));
const gaps = computed(() => leaves.value.filter(n => n.kind === 'gap' || !n.start || !n.end));
const owners = computed(() => [...new Set(leaves.value.map(n => n.owner).filter(Boolean))]);
const matching = computed(() => orderedNodes.value.filter(n => n.parentId && (!view.query.trim() || `${n.title} ${n.wbs} ${n.owner}`.toLowerCase().includes(view.query.trim().toLowerCase())) && (!view.workstream || n.workstreamId === view.workstream) && (!view.owner || n.owner === view.owner) && (!view.status || n.status === view.status)));
const filtered = computed(() => !!(view.query || view.workstream || view.owner || view.status));
const tree = computed(() => {
  const nodes = orderedNodes.value;
  const matchingIds = new Set(matching.value.map(n => n.id));
  if (!view.query.trim() && !view.owner && !view.status) {
    for (const group of groups.value) if (!view.workstream || group.workstreamId === view.workstream) matchingIds.add(group.id);
  }
  return buildPlanTree(nodes, matchingIds, view.collapsed, filtered.value);
});
const visibleRows = computed(() => tree.value.rows);
const treeMeta = (id: string) => tree.value.meta.get(id)!;
const baseline = computed(() => plan.value?.baselines.find(b => b.id === view.baselineId) || null);
const baselineEntries = computed(() => new Map(baseline.value?.entries.map(entry=>[entry.taskId,entry]) ?? []));
const differences = computed(() => !baseline.value ? [] : leaves.value.filter(n => { const entry = baselineEntries.value.get(n.id); return entry && (entry.start !== n.start || entry.end !== n.end || entry.owner !== n.owner || entry.effortHours !== n.effortHours); }));
const dependencyDifferences = computed(() => { if (!baseline.value || !plan.value) return []; const before = baseline.value.dependencies, after = plan.value.dependencies; const same = (a: typeof before[number], b: typeof before[number]) => a.predecessorId === b.predecessorId && a.successorId === b.successorId && a.lagDays === b.lagDays; return [...before.filter(a => !after.some(b => same(a,b))).map(e => ({ ...e, action: '移除' })), ...after.filter(a => !before.some(b => same(a,b))).map(e => ({ ...e, action: '新增' }))]; });
const rangeStart = computed(() => [plan.value?.project.start || '2026-09-07', ...leaves.value.map(n => n.start).filter((d): d is string => !!d), ...(baseline.value?.entries.map(e => e.start).filter((d): d is string => !!d) || [])].sort()[0]!);
const rangeEnd = computed(() => [plan.value?.project.end || '2026-12-31', ...leaves.value.map(n => n.end).filter((d): d is string => !!d), ...(baseline.value?.entries.map(e => e.end).filter((d): d is string => !!d) || [])].sort().at(-1)!);
const statusLabel = (s: string) => ({ todo:'待办', in_progress:'进行中', done:'已完成', review:'待验收' }[s] || s);
const stamp = (date: string) => new Date(date).toLocaleString('zh-CN', { hour12: false });
let loadSequence = 0;
async function load() {
  if (disposed) return;
  const request = ++loadSequence;
  loading.value = true; error.value = '';
  try {
    const initial = !plan.value;
    const [result, access] = await Promise.all([fetchPlan(pageProjectId, actorId.value), auth.session?.legacyDemo ? Promise.resolve(null) : fetchProject(pageProjectId)]);
    if (disposed || request !== loadSequence) return;
    // Keep the live canvas/list and its current viewport through scoped refreshes.
    const positions = Array.from(page.value?.querySelectorAll<HTMLElement>('.gantt-viewport, .plan-mobile-list') ?? []).map(element => ({ element, left: element.scrollLeft, top: element.scrollTop }));
    if (access) projectRole.value = access.role;
    plan.value = result;
    if (initial && !view.baselineId) view.baselineId = result.baselines[0]?.id || '';
    if (!view.initialized) { view.collapsed = result.nodes.filter(n => n.kind === 'group').map(n => n.id); view.initialized = true; }
    await nextTick();
    for (const position of positions) if (position.element.isConnected) {
      position.element.scrollLeft = position.left; position.element.scrollTop = position.top;
    }
  } catch (e) {
    if (disposed || request !== loadSequence) return;
    if (e instanceof PlanningError && [403,404].includes(e.status)) projectRole.value = undefined;
    error.value = e instanceof Error ? e.message : '计划暂时无法读取，请重试。';
  } finally { if (!disposed && request === loadSequence) loading.value = false; }
}
function select(node: PlanNode) {
  if (order.active) { order.select(node); return; }
  if (node.kind === 'milestone') {
    const { task: _task, taskTab: _tab, ...query } = route.query;
    void router.push({ path: route.path, query: { ...query, view: 'milestones', milestone: node.id } }); return;
  }
  proposal.value = undefined;
  if (isActualTask(node)) { selected.value = null; void router.push(taskLocation(node.id)); }
  else selected.value = node;
}
function reschedule(change: { taskId: string; start: string; end: string }) {
  if (!canEditSchedule.value || order.active) return;
  const node = plan.value?.nodes.find(n => n.id === change.taskId);
  if (node && isActualTask(node)) { selected.value = null; proposal.value = change; void router.push(taskLocation(node.id, 'plan')); }
}
function toggle(id: string) { view.collapsed = view.collapsed.includes(id) ? view.collapsed.filter(n => n !== id) : [...view.collapsed, id]; }
function clearFilters() { view.query = ''; view.owner = ''; view.workstream = ''; view.status = ''; }
async function saved(message: string) { selected.value = null; baselineOpen.value = false; await load(); if (disposed) return; emit('overview-changed'); emit('notify', message); }
async function showInfo(kind: 'history'|'differences') { info.value = kind; await nextTick(); infoDialog.value?.showModal(); }
async function toggleFullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await page.value?.requestFullscreen(); } catch { emit('notify', '当前浏览器未允许全屏，可收起侧栏扩大计划视图。'); } }
function fullscreenChange() { fullscreen.value = document.fullscreenElement === page.value; }
function locateToday() { const now = new Date(); const date = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`; if (date < rangeStart.value || date > rangeEnd.value) { emit('notify', `今天不在当前计划的日期范围内，已定位${plan.value!.project.isDemo ? '示例快照日' : '统计基准日'}。`); canvas.value?.locateDate(plan.value!.project.asOf); } else canvas.value?.locateDate(date); }
async function exportCsv() {
  if (!canExport.value || exporting.value || order.active) return;
  exporting.value = true;
  try {
    await verifyProjectExportAccess(pageProjectId);
    if (disposed || !plan.value) return;
  const escape = (value: unknown) => { let s = String(value ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"','""')}"`; };
  const rows = [['WBS','任务','类型','负责人','开始日期','结束日期','状态','进度','投入小时','数据性质'], ...matching.value.map(n => [n.wbs,n.title,n.kind,n.owner,n.start,n.end,statusLabel(n.status),`${n.progress}%`,n.effortHours,plan.value!.project.isDemo ? 'DEMO · 示例项目' : '当前项目计划'])];
  const blob = new Blob(['\uFEFF' + rows.map(row => row.map(escape).join(',')).join('\r\n')], { type:'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = projectCsvFilename(plan.value!.project, '完整计划'); a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); emit('notify', `已导出当前筛选范围的 ${matching.value.length} 项计划（含待排期）。`);
  } catch (error) { emit('notify', error instanceof Error ? error.message : '导出失败，请重试。'); }
  finally { exporting.value = false; }
}
let locateContext: { query:string; collapsed:string[]; owner:string; workstream:string } | null = null;
watch(() => [route.query.task,route.query.locate,route.query.view,plan.value] as const, async () => {
 if (route.query.locate !== 'milestone') { if (locateContext) { Object.assign(view,locateContext); locateContext = null; } return; }
 if (milestoneView.value || !plan.value || typeof route.query.task !== 'string') return;
 const node = plan.value.nodes.find(n => n.id === route.query.task); if (!node) return;
 if (!locateContext) locateContext = {query:view.query,collapsed:[...view.collapsed],owner:view.owner,workstream:view.workstream};
 view.query = node.title; view.workstream = ''; view.owner = ''; view.collapsed = []; selected.value = null;
 await nextTick(); canvas.value?.locateRow(node.id); mobileLimit.value = Math.max(mobileLimit.value,visibleRows.value.findIndex(n => n.id === node.id)+1);
});
function returnToMilestone() { const {task:_task,locate:_locate,fromMilestone:id,...query} = route.query; void router.push({path:route.path,query:{...query,view:'milestones',milestone:id}}); }
watch(() => [view.query, view.workstream, view.owner, view.status], () => { if (!order.active) view.collapsed = []; mobileLimit.value = 50; });
async function openActivityReference() {
  if (!plan.value) return;
  const baselineId = typeof route.query.baseline === 'string' ? route.query.baseline : '';
  const historyId = typeof route.query.history === 'string' ? route.query.history : '';
  if (baselineId) {
    if (!plan.value.baselines.some(item => item.id === baselineId)) { emit('notify', '该基线已不可用，项目动态中的历史信息仍保留。'); return; }
    view.baselineId = baselineId; await showInfo('differences');
  } else if (historyId) {
    if (!plan.value.history.some(item => item.id === historyId)) {
      try {
        const record = await fetchPlanHistory(pageProjectId, historyId);
        if (disposed || !plan.value || route.query.history !== historyId) return;
        if (!plan.value.history.some(item => item.id === historyId)) plan.value.history.push(record);
      } catch (error) { emit('notify', error instanceof Error ? error.message : '变更记录读取失败，请重试。'); return; }
    }
    await showInfo('history');
    await nextTick();
    const record = Array.from(infoDialog.value?.querySelectorAll<HTMLElement>('[data-history-id]') || []).find(item => item.dataset.historyId === historyId);
    record?.scrollIntoView({block:'center'}); record?.focus();
  }
}
watch(() => [route.query.baseline, route.query.history], () => { void openActivityReference(); });
onMounted(() => { void load().then(openActivityReference); document.addEventListener('fullscreenchange', fullscreenChange); });
onBeforeUnmount(() => { document.removeEventListener('fullscreenchange', fullscreenChange); infoDialog.value?.close(); });
defineExpose({ confirmNavigation: protectNavigation, isDirty: computed(() => !!taskHost.value?.isDirty), isBusy: computed(() => !!taskHost.value?.isBusy), refreshForCollaboration: async () => { if (milestoneView.value) return await milestonePage.value?.refreshForCollaboration() ?? false; if (order.active) { emit('notify', '请先保存或取消顺序调整，当前草稿已保留。'); return false; } if (taskHost.value?.isBusy || taskHost.value?.isDirty) { emit('notify', '请先保存或关闭任务详情，当前填写内容已保留。'); return false; } const detailOk = taskHost.value ? await taskHost.value.refresh() : true; await load(); return detailOk && !disposed && !error.value; } });
</script>
<template>
  <section ref="page" class="plan-page plan-workspace" :style="{ '--plan-available-height': `${availableHeight}px` }" :class="{ 'is-gantt-view': !milestoneView, 'plan-fullscreen': fullscreen, 'is-ordering': order.active }" aria-labelledby="plan-page-title">
    <header class="plan-page-heading"><h1 id="plan-page-title">完整计划</h1>
      <nav class="plan-mode-tabs" aria-label="完整计划视图"><button role="tab" :aria-selected="!milestoneView" :class="{active:!milestoneView}" :disabled="order.active" @click="switchPlanView('gantt')">甘特图</button><button role="tab" :aria-selected="milestoneView" :class="{active:milestoneView}" :disabled="order.active" @click="switchPlanView('milestones')">里程碑</button></nav>
      <div v-if="!mobile || milestoneView" class="plan-heading-actions"><button v-if="canExport && !milestoneView" class="button" :disabled="!plan || exporting || order.active" @click="exportCsv"><Icon name="arrow" :size="15"/>导出计划</button><button v-if="canPlan" class="button" :class="{primary:!milestoneView}" :disabled="!plan || loading || order.active" @click="baselineOpen = true"><Icon name="flag" :size="16"/>{{ milestoneView ? '基线管理' : '发布基线' }}</button></div>
      <button v-else class="plan-text-button plan-more-button" :disabled="!plan || order.active" @click="popup = 'more'">更多</button>
    </header>
    <BaselineDialog v-if="milestoneView && baselineOpen && plan" :read-only="!canPlan" :plan="plan" @close="baselineOpen = false" @saved="saved" @stale="load"/>
    <MilestoneWorkspace v-if="milestoneView" ref="milestonePage" :plan-filters="view" @overview-changed="load(); emit('overview-changed')" @notify="emit('notify',$event)"/>
    <PlanTaskDetailHost v-if="detailTaskId && !order.active" ref="taskHost" :project-id="pageProjectId" :task-id="detailTaskId" :actor-id="actorId"
      :initial-tab="route.query.taskTab === 'plan' ? 'plan' : 'detail'" :initial-plan-editing="route.query.taskTab === 'plan' && canEditSchedule"
      :plan-proposal="proposal?.taskId === detailTaskId ? proposal : undefined"
      @close="closeTask" @changed="taskChanged" @notify="emit('notify', $event)" @open-task="openRelatedTask" @show-plan="showTaskPlan"
      @manage-workstreams="navigateHandled({ name: 'workstreams', params: { projectId: pageProjectId } })"/>
    <template v-if="!milestoneView">
    <button v-if="route.query.locate === 'milestone' && route.query.fromMilestone" class="plan-text-button" @click="returnToMilestone">← 返回里程碑详情</button>
    <div v-if="!plan && loading" class="plan-loading" role="status"><div class="loading-line"></div><p>正在读取完整计划与基线…</p></div>
    <div v-if="error" class="plan-error" role="alert">{{ error }} <button class="plan-text-button" @click="load">重新加载计划</button></div>
    <template v-if="plan">
      <div class="plan-summary"><span>{{ leaves.filter(n => n.kind === 'task').length }} 项任务 · {{ leaves.filter(n => n.kind === 'milestone').length }} 个里程碑 · {{ groups.length }} 个分组</span><span class="plan-summary-dates">{{ plan.project.start.slice(5) }} — {{ plan.project.end.slice(5) }}</span><span class="plan-version">执行计划 V{{ plan.planVersion }}</span><button class="plan-text-button plan-about-button" @click="popup = 'about'">{{ plan.project.isDemo ? 'DEMO · 示例排期' : '计划说明' }} <Icon name="info" :size="14"/></button></div>
      <div class="plan-board">
        <PlanOrderControls compact :order="order" :scope-name="groups.find(group => group.workstreamId === view.workstream)?.title || '全部工作分组'" @expand="view.collapsed = []" />
        <div v-if="!order.active" class="plan-filter-row"><label class="plan-search"><Icon name="search" :size="16"/><input v-model="view.query" placeholder="搜索任务、WBS、负责人" aria-label="搜索计划任务"/><button v-if="view.query" class="icon-button" aria-label="清空计划搜索" @click="view.query = ''"><Icon name="close" :size="14"/></button></label><PlanFilters v-if="!mobile" :view="view" :groups="groups" :owners="owners" :baselines="plan.baselines"/><button v-else class="button plan-filter-trigger" @click="popup = 'filters'">筛选{{ filterCount ? ` ${filterCount}` : '' }}</button><button v-if="filtered && !mobile" class="plan-text-button" @click="clearFilters">重置筛选</button></div>
        <div v-if="!order.active && !mobile" class="plan-view-toolbar" :class="{ 'mobile-list-mode': view.mobileView === 'list' }"><div class="plan-toolbar-left"><button class="plan-text-button" @click="view.collapsed = view.collapsed.length ? [] : plan.nodes.filter(n => n.kind === 'group').map(n => n.id)"><Icon name="layers" :size="16"/>{{ view.collapsed.length ? '展开全部' : '收起全部' }}</button><button v-if="canPlan" class="plan-text-button" :disabled="loading || !matching.length" @click="order.requestBegin">调整顺序</button><span class="plan-toolbar-separator"></span><label class="plan-critical-toggle"><input v-model="view.critical" type="checkbox"/>关键路径</label><span v-if="view.critical" class="plan-coverage-tag">{{ plan.criticalCoverage.complete ? '已覆盖排期' : '部分覆盖' }}</span></div><div class="plan-toolbar-right"><button class="plan-text-button" @click="locateToday">定位今天</button><button class="plan-text-button" @click="view.zoom = 'month'; view.fit = true; canvas?.resetScroll()">全项目</button><div class="plan-segments" aria-label="时间轴缩放"><button v-for="(label, key) in { day:'日', week:'周', month:'月' }" :key="key" :class="{ active:view.zoom === key }" :aria-pressed="view.zoom === key" @click="view.zoom = key; view.fit = false">{{ label }}</button></div><button class="icon-button plan-fullscreen-button" :aria-label="fullscreen ? '退出全屏计划' : '全屏查看计划'" @click="toggleFullscreen"><Icon name="expand" :size="16"/><span>{{ fullscreen ? '退出全屏' : '全屏' }}</span></button></div></div>

        <div v-if="mobile && !order.active" class="plan-mobile-tools"><button class="plan-text-button" @click="view.collapsed = view.collapsed.length ? [] : plan.nodes.filter(n => n.kind === 'group').map(n => n.id)">{{ view.collapsed.length ? '展开全部' : '收起全部' }}</button><button v-if="canPlan" class="plan-text-button" :disabled="loading || !matching.length" @click="order.requestBegin">调整顺序</button><button v-if="view.mobileView === 'timeline'" class="plan-text-button" @click="locateToday">定位今天</button><button v-if="view.mobileView === 'timeline'" class="plan-text-button" @click="popup = 'zoom'">缩放</button></div>
        <div v-if="!order.active" class="plan-mobile-switch plan-segments"><button :class="{ active: view.mobileView === 'list' }" @click="view.mobileView = 'list'">计划列表</button><button :class="{ active: view.mobileView === 'timeline' }" @click="view.mobileView = 'timeline'">甘特时间轴</button></div>
        <div v-if="!visibleRows.length" class="plan-empty"><Icon name="search" :size="30"/><h3>{{ leaves.length ? '没有符合条件的计划项' : '还没有计划任务' }}</h3><p>{{ leaves.length ? '调整搜索词或清除筛选，查看完整项目范围。' : '项目从空白开始。先在任务管理中创建任务并安排日期，这里会同步展示完整计划。' }}</p><button v-if="leaves.length" class="button" @click="clearFilters">清除筛选</button><RouterLink v-else class="button" :to="{name:'tasks'}">前往任务管理</RouterLink></div>
        <template v-else><div class="plan-canvas-wrap" :class="{ 'mobile-hidden': view.mobileView === 'list' }"><GanttCanvas ref="canvas" fill :read-only="!canEditSchedule || order.active" :ordering="order.active" :order-locked="order.locked" :rows="visibleRows" :tree="tree.meta" :dependencies="plan.dependencies" :baseline="baseline" :critical-ids="plan.criticalIds" :show-critical="view.critical" :zoom="view.zoom" :fit="view.fit" :range-start="rangeStart" :range-end="rangeEnd" :snapshot-date="plan.project.asOf" :is-demo="plan.project.isDemo" :collapsed-ids="view.collapsed" :selected-id="order.active ? order.selectedId : detailTaskId || selected?.id || null" @select="select" @toggle="toggle" @reschedule="reschedule" @reorder="change => order.move(change.id, change.targetId, change.placement)"/></div><div v-if="mobile" class="plan-mobile-list" :class="{ 'mobile-hidden': view.mobileView === 'timeline' }"><article v-for="row in visibleRows.slice(0,mobileLimit)" :key="row.id" class="plan-tree-mobile-row" :class="{ 'plan-order-mobile-item': order.active, 'is-selected': order.active && order.selectedId === row.id, 'is-parent': treeMeta(row.id).isParent, 'is-workstream': !row.parentId, 'is-subtree-end': treeMeta(row.id).subtreeEnd }" :data-order-id="row.id" :data-node-id="row.id" :data-tree-depth="treeMeta(row.id).depth" :style="{ '--depth': Math.min(treeMeta(row.id).depth, 3) }">
          <PlanTreeLines :meta="treeMeta(row.id)" />
          <div v-if="row.kind === 'group'" class="plan-order-mobile-group">
            <button class="icon-button" :aria-label="`${view.collapsed.includes(row.id) ? '展开' : '收起'}${row.title}`" :aria-expanded="!view.collapsed.includes(row.id)" :disabled="order.active && order.busy" @click="toggle(row.id)"><Icon :name="view.collapsed.includes(row.id) ? 'chevron' : 'down'" :size="15"/></button>
            <button class="plan-mobile-group" :title="treeMeta(row.id).path" :disabled="order.active && (!row.parentId || order.busy)" @click="select(row)">
              <b>{{ row.title }}</b>
              <span>{{ treeMeta(row.id).caption }}{{ !row.start || !row.end ? ' · 待排期' : '' }}</span>
              <span v-if="treeMeta(row.id).parentIsTask" class="plan-parent-context">父任务：{{ treeMeta(row.id).parentTitle }}</span>
              <span v-if="order.active && order.selectedId === row.id">已选中</span>
            </button>
          </div>
          <button v-else class="plan-mobile-task" :title="treeMeta(row.id).path" :disabled="order.active && order.busy" :aria-pressed="order.active ? order.selectedId === row.id : undefined" @click="select(row)">
            <span class="plan-mobile-task-top"><span>{{ row.wbs }} · {{ row.kind === 'milestone' ? '里程碑' : row.kind === 'gap' ? '待细化' : '任务' }}</span><span>{{ order.active && order.selectedId === row.id ? '已选中 · ' : '' }}{{ statusLabel(row.status) }}{{ view.critical && plan.criticalIds.includes(row.id) ? ' · 关键' : '' }}</span></span>
            <b>{{ row.title }}</b>
            <span v-if="treeMeta(row.id).parentTitle" class="plan-parent-context">{{ treeMeta(row.id).parentIsTask ? '父任务' : '工作分组' }}：{{ treeMeta(row.id).parentTitle }}</span>
            <span class="plan-mobile-task-bottom">{{ row.start ? `${row.start.slice(5)} → ${row.end?.slice(5)}` : '待排期' }}<span>{{ row.owner || '待明确负责人' }}</span></span>
          </button>
          <template v-if="order.active && order.selectedId === row.id"><p v-if="order.descendants" class="plan-field-note">将连同 {{ order.descendants }} 项子任务一起移动</p><div class="plan-order-mobile-actions"><button class="button" :disabled="!order.canUp" @click="order.step('up')">上移</button><button class="button" :disabled="!order.canDown" @click="order.step('down')">下移</button><button class="button" :disabled="!order.canPosition" @click="order.positionOpen = true">移动到...</button></div></template>
        </article><button v-if="visibleRows.length > mobileLimit" class="button" @click="mobileLimit += 50">加载更多计划（{{ Math.min(mobileLimit,visibleRows.length) }} / {{ visibleRows.length }}）</button></div></template>

        <footer class="plan-board-footer plan-baseline-controls"><button class="plan-text-button" @click="popup = 'legend'">图例</button><button class="plan-text-button plan-check-trigger" :aria-expanded="issuesOpen" @click="issuesOpen = !issuesOpen">待排期 {{ gaps.length }} · 提示 {{ plan.issues.length }} <span>查看</span></button><button v-if="baseline" class="plan-text-button" @click="showInfo('differences')">{{ differences.length }} 项偏差</button><button class="plan-text-button" @click="showInfo('history')">变更记录</button></footer>
        <section v-if="issuesOpen && !checksModal" class="plan-check-panel" aria-label="计划完整性检查"><header><h2>计划完整性检查</h2><button class="icon-button" aria-label="关闭计划完整性检查" @click="closeChecks">×</button></header><PlanChecks :gaps="gaps" :issues="plan.issues" :nodes="leaves" @select="selectFromChecks"/></section>
      </div>
      <OrderDialog v-if="issuesOpen && checksModal" title="计划完整性检查" @close="closeChecks"><PlanChecks :gaps="gaps" :issues="plan.issues" :nodes="leaves" @select="selectFromChecks"/></OrderDialog>
      <OrderDialog v-if="popup" :title="{filters:'筛选计划',more:'计划操作',legend:'甘特图图例',about:'计划说明',zoom:'时间轴缩放'}[popup]" @close="popup = null">
        <template v-if="popup === 'filters'"><div class="plan-mobile-filters"><PlanFilters :view="view" :groups="groups" :owners="owners" :baselines="plan.baselines"/></div><label class="plan-critical-toggle"><input v-model="view.critical" type="checkbox"/>关键路径</label><button class="plan-text-button" @click="clearFilters">重置筛选</button></template>
        <div v-if="popup === 'more'" class="plan-more-actions"><button v-if="canExport" class="button" :disabled="exporting" @click="popup = null; exportCsv()">导出计划</button><button v-if="canPlan" class="button primary" :disabled="loading" @click="popup = null; baselineOpen = true">发布基线</button><button class="button" @click="popup = 'about'">计划说明</button></div>
        <div v-if="popup === 'zoom'" class="plan-zoom-options"><button class="button" @click="view.zoom = 'month'; view.fit = true; canvas?.resetScroll()">全项目</button><div class="plan-segments" aria-label="时间轴缩放"><button v-for="(label, key) in { day:'日', week:'周', month:'月' }" :key="key" :class="{active:view.zoom === key}" :aria-pressed="view.zoom === key" @click="view.zoom = key; view.fit = false">{{ label }}</button></div></div>
        <template v-if="popup === 'about'"><p v-if="plan.project.isDemo"><span class="demo-label">DEMO</span> 示例排期 · 修改仅保存在本机，不代表真实团队进度。</p><p>目标窗口：{{ plan.project.start }} — {{ plan.project.end }}</p><p>工作日历：{{ calendarDescription(plan.calendar) }}</p><p>{{ plan.project.isDemo ? '示例快照日' : '统计基准日' }} {{ plan.project.asOf }} · 执行计划 V{{ plan.planVersion }}</p></template>
        <template v-if="popup === 'legend'"><div class="gantt-legend" aria-label="甘特图图例"><span><i class="legend-completed"></i>已完成进度</span><span><i class="legend-remaining"></i>剩余进度</span><span><i class="legend-milestone"></i>里程碑</span><span v-if="baseline"><i class="legend-baseline"></i>对比基线</span><span v-if="view.critical">! 关键路径</span></div><p>{{ plan.criticalCoverage.message }}</p><p>筛选、折叠或待排期导致的隐藏依赖仍参与计算。</p><p>{{ order.active ? '选择任务后可用上移、下移或指定位置；拖动手柄预览顺序。' : '点击任务查看详情；拖动后预览变更。' }}</p></template>
        <template #footer><button class="button primary" @click="popup = null">{{ popup === 'filters' ? '完成筛选' : '返回计划' }}</button></template>
      </OrderDialog>
      <PlanChangeDialog v-if="selected && !order.active" :key="selected.id" read-only :plan="plan" :node="selected" @close="closeTask" @stale="load"/>
      <BaselineDialog v-if="baselineOpen" :read-only="!canPlan" :plan="plan" @close="baselineOpen = false" @saved="saved" @stale="load"/>
      <dialog v-if="info" ref="infoDialog" class="plan-dialog plan-info-dialog" aria-labelledby="plan-info-title" @close="info = null"><header class="plan-dialog-header"><div><span class="eyebrow">PLAN RECORDS</span><h2 id="plan-info-title">{{ info === 'history' ? '计划变更记录' : '与基线的偏差' }}</h2></div><button class="icon-button" aria-label="关闭计划记录" @click="infoDialog?.close()"><Icon name="close"/></button></header><div class="plan-dialog-body"><template v-if="info === 'history'"><p class="plan-description">当前项目的顺序、改期、依赖及基线记录，按最近发生排序。</p><article v-for="item in [...plan.history].sort((a,b) => b.createdAt.localeCompare(a.createdAt))" :key="item.id" class="plan-record" :data-history-id="item.id" tabindex="-1"><span class="plan-record-dot"></span><h3>{{ ({ schedule_apply:'调整执行计划', baseline_publish:'发布计划基线', seed: plan.project.isDemo ? '创建示例计划' : '创建计划', '应用计划调整（DEMO）': plan.project.isDemo ? '应用计划调整（DEMO）' : '应用计划调整', '发布计划基线（DEMO）': plan.project.isDemo ? '发布计划基线（DEMO）' : '发布计划基线' } as Record<string,string>)[item.action] || item.action }}</h3><p>{{ item.reason }}</p><small>{{ item.actor }} · {{ stamp(item.createdAt) }} · {{ item.affectedCount }} 项</small><details v-if="item.orders?.length"><summary class="plan-text-button">查看顺序变更</summary><section v-for="group in item.orders" :key="group.parentId"><h4>{{ plan.nodes.find(node => node.id === group.parentId)?.title || '原所属层级' }}</h4><div class="order-comparison"><div><h4>调整前</h4><OrderSequence :ids="group.before" :nodes="plan.nodes" /></div><div><h4>调整后</h4><OrderSequence :ids="group.after" :nodes="plan.nodes" /></div></div></section></details></article><p v-if="!plan.history.length" class="plan-empty-note">还没有计划变更。保存改期或发布基线后，这里会保留记录。</p></template><template v-else-if="baseline"><p class="plan-description">对比 {{ baseline.name }} · {{ stamp(baseline.createdAt) }}</p><p class="plan-field-note">{{ baseline.reason }} · 明确排除 {{ baseline.excludedIds.length }} 项待排期内容。下方列出日期、负责人或投入发生变化的计划项；依赖关系单独列出。</p><article v-for="node in differences" :key="node.id" class="plan-change-row"><h3>{{ node.title }}</h3><p class="plan-old-date">基线 {{ baselineEntries.get(node.id)?.start }} → {{ baselineEntries.get(node.id)?.end }}</p><p>当前 {{ node.start }} → {{ node.end }}</p></article><p v-if="!differences.length" class="plan-empty-note">当前计划项与所选基线一致，暂无日期、负责人或投入偏差。</p><h3>依赖与日历快照</h3><p class="plan-description">基线 {{ baseline.dependencies.length }} 条依赖 / 当前 {{ plan.dependencies.length }} 条依赖；基线每工作日 {{ baseline.calendar.hoursPerDay }} 小时。</p><div v-for="(edge, index) in dependencyDifferences" :key="index" class="plan-change-row">{{ edge.action }}：{{ leaves.find(n => n.id === edge.predecessorId)?.title }} → {{ leaves.find(n => n.id === edge.successorId)?.title }} · 间隔 {{ edge.lagDays }} 工作日</div><p v-if="!dependencyDifferences.length" class="plan-field-note">依赖关系与基线一致。</p></template></div><footer class="plan-dialog-footer"><button class="button primary" @click="infoDialog?.close()">返回计划</button></footer></dialog>
    </template>
    </template>
  </section>
</template>
