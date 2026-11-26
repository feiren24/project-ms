<script lang="ts">
import { useProjectView, currentProjectId } from '../../stores/project-scope';
import type { AnalyticsFilters } from '../../../../shared/src/analytics';
import type { AnalysisView } from './export';
import type { PersonnelSelection, PersonnelViewState } from './personnel';
const defaultView = () => ({
  tab: 'delivery' as AnalysisView,
  filters: { from: '', to: '', workstreamId: '', ownerId: '', baselineId: '', capacityMode: 'unknown' } as AnalyticsFilters,
  initialized: false, deviationState: '', weekOffset: 0,
  personnel: { sortBy: 'default', direction: 'desc', expanded: [] } as PersonnelViewState,
  selection: null as { title: string; ids: string[]; hours?: Record<string, number>; personnel?: PersonnelSelection } | null,
});
</script>
<script setup lang="ts">
import { verifyProjectExportAccess } from '../../utils/project-permissions';
import { canWriteProject } from '../../../../shared/src/permissions';
import { useAuthStore } from '../../stores/auth';
import { projectCsvFilename } from '../../utils/project-presentation';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { AnalyticsCapacityCell, AnalyticsReport, AnalyticsMetric } from '../../../../shared/src/analytics';
import type { EChartsCoreOption } from 'echarts/core';
import { fetchAnalytics } from '../../api/analytics';
import AnalyticsChart from './AnalyticsChart.vue';
import PersonnelAnalysis from './PersonnelAnalysis.vue';
import { personnelSelectionIds, personnelStateLabels, referenceSourceLabels } from './personnel';
import { analyticsCsv, analysisViewLabels, deviationLabels, taskStatusLabels } from './export';
import './analytics-page.css';
const view = useProjectView('analytics', defaultView);
const pageProjectId = currentProjectId();
const auth = useAuthStore();
const exporting = ref(false), detailLoading = ref(false);
const detailLimit = ref(50), deviationLimit = ref(50), unallocatedLimit = ref(50);
const canExport = computed(() => !!auth.session?.legacyDemo || canWriteProject(auth.session?.projects.find(p => p.id === pageProjectId)?.role));
const emit = defineEmits<{ notify: [message: string] }>();
const report = ref<AnalyticsReport | null>(null), loading = ref(false), error = ref('');
const options = ref<AnalyticsReport['options']>({ workstreams: [], owners: [], baselines: [] });
const detailSection = ref<HTMLElement>();
const page = ref<HTMLElement>();
const weeksPerPage = ref(4);
const chartColors = ref<string[]>([]);
let disposed = false;
let controller: AbortController | undefined;
let requestId = 0;
let normalizing = false;
let observer: ResizeObserver | undefined;
let filterTimer: ReturnType<typeof setTimeout> | undefined;
const exportUrls = new Set<string>();
const percentage = (value: number | null) => value === null ? '暂无可计算数据' : `${Number((value * 100).toFixed(1))}%`;
const number = (value: number | null) => value === null ? '未知' : Number(value.toFixed(1)).toLocaleString('zh-CN');
const stamp = (value: string | null) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '尚未采集';
const metricCards = computed(() => report.value ? ([
  { key: 'completion', title: '任务完成率', unit: '项执行任务', metric: report.value.metrics.completion },
  { key: 'weightedProgress', title: '工时加权进度', unit: '小时', metric: report.value.metrics.weightedProgress },
  { key: 'estimationCoverage', title: '估算覆盖率', unit: '项执行任务', metric: report.value.metrics.estimationCoverage },
  { key: 'onTime', title: '按期完成率', unit: '项可判定任务', metric: report.value.metrics.onTime },
]) : []);
const knownTasks = computed(() => new Map(report.value?.tasks.map(task => [task.id, task]) || []));
const selectedTasks = computed(() => (view.selection?.ids || []).map(id => ({ id, task: knownTasks.value.get(id), deviation: report.value?.deviations.find(item => item.taskId === id), hours: view.selection?.hours?.[id] })));
const personnelTimings = computed(() => new Map(report.value?.personnel.tasks.map(t => [t.taskId, t]) || []));
const deviations = computed(() => report.value?.deviations.filter(item => !view.deviationState || item.state === view.deviationState) || []);
const visibleWeeks = computed(() => report.value?.capacity.weeks.slice(view.weekOffset, view.weekOffset + weeksPerPage.value) || []);
const latestCapture = computed(() => report.value?.trend.points.filter(p => p.capturedAt).map(p => p.capturedAt!).sort().at(-1) || null);
const capacityLabels = computed(() => ({ unknown: '容量未知', empty: '无分配', normal: report.value?.capacity.mode === 'configured' ? '负荷正常' : '试算正常', overload: report.value?.capacity.mode === 'configured' ? '已配置容量超额' : '试算超载', conflict: '零容量冲突' }));
const trendOption = computed<EChartsCoreOption>(() => ({
  animation: false, color: chartColors.value, tooltip: { trigger: 'axis', renderMode: 'richText', valueFormatter: (value: unknown) => typeof value === 'number' ? `${number(value)}%` : '未采集 / 无估算' },
  grid: { left: 44, right: 16, top: 42, bottom: 32 }, legend: { top: 8, data: ['基线计划参考', '本机实际采集'], textStyle: { fontSize: 11 } },
  xAxis: { type: 'category', data: report.value?.trend.points.map(p => p.date) || [], axisLabel: { fontSize: 10, formatter: (value: string) => value.slice(5) }, boundaryGap: false },
  yAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } },
  series: [
    { name: '基线计划参考', type: 'line', showSymbol: false, connectNulls: false, lineStyle: { type: 'dashed' }, data: report.value?.trend.points.map(p => p.planned === null ? null : p.planned * 100) || [] },
    { name: '本机实际采集', type: 'line', symbolSize: 7, connectNulls: false, data: report.value?.trend.points.map(p => p.actual === null ? null : p.actual * 100) || [] },
  ],
}));
const workstreamOption = computed<EChartsCoreOption>(() => ({
  animation: false, color: chartColors.value.slice(0, 1), tooltip: { trigger: 'axis', renderMode: 'richText', valueFormatter: (value: unknown) => typeof value === 'number' ? `${number(value)}%` : '暂无可计算数据' },
  grid: { left: 116, right: 24, top: 8, bottom: 28 },
  xAxis: { type: 'value', min: 0, max: 100, axisLabel: { formatter: '{value}%', fontSize: 10 } },
  yAxis: { type: 'category', inverse: true, data: report.value?.workstreams.map(w => w.name) || [], axisLabel: { width: 102, overflow: 'truncate', fontSize: 10 } },
  series: [{ type: 'bar', barMaxWidth: 16, itemStyle: { borderRadius: [0, 4, 4, 0] }, data: report.value?.workstreams.map(w => w.completion === null ? null : w.completion * 100) || [] }],
}));
async function load() {
  clearTimeout(filterTimer);
  controller?.abort(); controller = new AbortController(); const current = ++requestId; detailLoading.value = false;
  loading.value = true; error.value = ''; report.value = null;
  try {
    const result = await fetchAnalytics(view.initialized ? { ...view.filters } : {}, controller.signal, view.tab === 'delivery' && !view.selection ? 'summary' : 'full');
    if (current !== requestId) return;
    normalizing = true; Object.assign(view.filters, result.filters); view.initialized = true; normalizing = false;
    report.value = result; options.value = result.options;
    if (view.tab !== 'delivery' && result.detailLevel === 'summary') await ensureDetails();
    if (view.selection?.personnel) view.selection.ids = personnelSelectionIds(result.personnel, view.selection.personnel);
    view.weekOffset = Math.min(view.weekOffset, Math.max(0, result.capacity.weeks.length - weeksPerPage.value));
  } catch (e) {
    if (current !== requestId || (e instanceof Error && e.name === 'AbortError')) return;
    error.value = e instanceof Error ? e.message : '统计数据暂时无法读取，请重试。';
  } finally { if (current === requestId) loading.value = false; }
}
async function ensureDetails(): Promise<boolean> {
  if (!report.value || detailLoading.value) return false;
  if (report.value.detailLevel !== 'summary') return true;
  detailLoading.value = true; const current = requestId;
  try { const result = await fetchAnalytics({...view.filters},controller?.signal,'full');
    if (disposed || current !== requestId) return false;
    report.value = result; error.value = ''; return true;
  } catch(e) { if (disposed || current !== requestId) return false; if (!(e instanceof Error && e.name === 'AbortError')) { error.value=e instanceof Error ? e.message : '读取明细失败，请重试。'; emit('notify',error.value); } return false; }
  finally { if (current === requestId) detailLoading.value = false; }
}
async function selectTasks(title: string, ids: string[], hours?: Record<string, number>) {
  if (!await ensureDetails()) return;
  detailLimit.value=50;
  view.selection = { title, ids: [...new Set(ids)], hours };
  await nextTick(); detailSection.value?.scrollIntoView({ block: 'start', behavior: 'auto' }); detailSection.value?.focus({ preventScroll: true });
}
async function selectPersonnel(title: string, ids: string[], selection: PersonnelSelection) {
  await selectTasks(title, ids);
  if (view.selection) view.selection.personnel = selection;
}
function selectMetric(title: string, metric: AnalyticsMetric) { selectTasks(title, metric.taskIds); }
function selectWorkstream(index: number) { const stream = report.value?.workstreams[index]; if (stream) selectTasks(`${stream.name} · 执行任务`, stream.taskIds); }
function selectCapacity(member: string, week: string, cell: AnalyticsCapacityCell) { selectTasks(`${member} · ${week} · 分配 ${number(cell.plannedHours)} 小时`, cell.tasks.map(task => task.taskId), Object.fromEntries(cell.tasks.map(task => [task.taskId, task.hours]))); }
function cellFor(member: AnalyticsReport['capacity']['members'][number], week: string) { return member.cells.find(cell => cell.week === week); }
function moveWeeks(direction: number) { view.weekOffset = Math.max(0, Math.min(Math.max(0, (report.value?.capacity.weeks.length || 0) - weeksPerPage.value), view.weekOffset + direction * weeksPerPage.value)); }
async function exportCurrent() {
  if (!canExport.value || exporting.value) return;
  exporting.value = true;
  try {
    await verifyProjectExportAccess(pageProjectId, 'analytics');
    if (disposed) return;
  if (!await ensureDetails() || !report.value) return;
  const url = URL.createObjectURL(new Blob([analyticsCsv(report.value, view.tab, view.deviationState)], { type: 'text/csv;charset=utf-8' }));
  exportUrls.add(url); const link = document.createElement('a'); link.href = url; link.download = projectCsvFilename(report.value.project, `统计分析-${analysisViewLabels[view.tab]}`); link.click();
  setTimeout(() => { URL.revokeObjectURL(url); exportUrls.delete(url); }, 1000);
  emit('notify', `已导出当前筛选的${analysisViewLabels[view.tab]}${view.tab === 'capacity' ? '（包含全部周）' : ''}。`);
  } catch (error) { emit('notify', error instanceof Error ? error.message : '导出失败，请重试。'); }
  finally { exporting.value = false; }
}
watch(() => view.tab,async tab => { if(tab !== 'delivery') await ensureDetails(); });
watch(() => view.deviationState,()=>{deviationLimit.value=50;});
watch(() => ({ ...view.filters }), () => { if (!normalizing && view.initialized) { ++requestId; controller?.abort(); report.value = null; loading.value = false; detailLoading.value = false; error.value = ''; view.selection = null; view.weekOffset = 0; detailLimit.value=50; deviationLimit.value=50; unallocatedLimit.value=50; clearTimeout(filterTimer); filterTimer=setTimeout(()=>void load(),150); } }, { flush: 'sync' });
onMounted(() => { const tokens = getComputedStyle(document.documentElement); chartColors.value = [tokens.getPropertyValue('--primary').trim(), tokens.getPropertyValue('--green').trim()]; load(); observer = new ResizeObserver(entries => { const width = entries[0]?.contentRect.width || 1000; weeksPerPage.value = width < 480 ? 1 : width < 780 ? 2 : 4; if (report.value) view.weekOffset = Math.min(view.weekOffset, Math.max(0, report.value.capacity.weeks.length - weeksPerPage.value)); }); if (page.value) observer.observe(page.value); });
onBeforeUnmount(() => { clearTimeout(filterTimer); disposed = true; ++requestId; controller?.abort(); observer?.disconnect(); for (const url of exportUrls) URL.revokeObjectURL(url); exportUrls.clear(); });
defineExpose({ refreshForCollaboration: async () => { await load(); return !error.value; } });
</script>
<template>
  <section ref="page" class="analytics-page" aria-labelledby="analytics-title">
    <header class="analytics-heading"><div><span class="eyebrow">INSIGHT & DELIVERY</span><h1 id="analytics-title">统计分析<span class="analytics-title-dot"></span></h1><p>看清交付进展、计划偏差与每个人的投入。</p></div><div class="analytics-actions"><button v-if="canExport" class="button" :disabled="!report || loading || exporting" @click="exportCurrent">导出当前分析</button><button class="button primary" :disabled="loading" @click="load">刷新统计</button></div></header>
    <div v-if="report?.project.isDemo" class="analytics-notice"><span class="demo-label">DEMO</span><p>本机示例统计 · 计划窗口用于筛选当前任务，不代表历史回放。<span v-if="report">{{ report.project.isDemo ? '示例快照日' : '统计基准日' }} {{ report.dataAsOf }} · 执行计划 V{{ report.planVersion }}</span></p></div>
    <form class="analytics-filters" @submit.prevent="load">
      <label>计划开始<input v-model="view.filters.from" type="date" aria-label="统计开始日期" :disabled="!view.initialized"></label>
      <label>计划结束<input v-model="view.filters.to" type="date" aria-label="统计结束日期" :disabled="!view.initialized"></label>
      <label>工作分组<select v-model="view.filters.workstreamId" aria-label="统计工作分组筛选" :disabled="!view.initialized"><option value="">全部工作分组</option><option v-for="item in options.workstreams" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>负责人<select v-model="view.filters.ownerId" aria-label="统计负责人筛选" :disabled="!view.initialized"><option value="">全部负责人</option><option v-for="item in options.owners" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
      <label>对比基线<select v-model="view.filters.baselineId" aria-label="统计基线" :disabled="!view.initialized"><option v-if="!options.baselines.length" value="">暂无基线</option><option v-for="item in options.baselines" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
    </form>
    <nav class="analytics-tabs" aria-label="统计分析视图"><button v-for="(label, key) in analysisViewLabels" :key="key" :class="{ active: view.tab === key }" :aria-pressed="view.tab === key" @click="view.tab = key">{{ label }}</button></nav>
    <div v-if="loading" class="analytics-state" role="status">正在读取当前筛选的统计数据…</div>
    <div v-else-if="error" class="analytics-error" role="alert"><p>{{ error }}</p><button class="button" @click="load">重试统计</button></div>
    <p v-if="detailLoading" role="status">正在读取完整明细…</p>
    <template v-if="report && !loading">
      <details class="analytics-definitions"><summary>指标说明与数据提示<span>{{ report.metricVersion }}</span></summary><div><p>执行任务统计排除已取消、汇总父任务与里程碑；未排期任务保留并单列。未知数值不按零计算，卡片显示分子、分母与缺失项。</p><p>按期完成需真实完成日期，优先比较选定基线；无基线条目时使用完成时冻结的计划结束日。负责人、工作分组按当前归属筛选。</p><p v-for="card in metricCards" :key="card.key"><b>{{ card.title }}：</b>{{ card.metric.description }}</p><p><b>{{ report.project.isDemo ? '里程碑示例达成率' : '里程碑达成率' }}：</b>{{ report.metrics.milestoneAchievement.description }} · 缺失 {{ report.metrics.milestoneAchievement.missing }} 项</p><p>已完成但缺少真实完成日：<strong>{{ report.counts.unknownActual }} 项</strong>。这些任务不能用于判定按期完成或实际偏差。</p><p>实际采集时间：{{ stamp(latestCapture) }}；首次采集：{{ stamp(report.trend.firstCapturedAt) }}。{{ report.project.isDemo ? '示例快照日' : '统计基准日' }} {{ report.dataAsOf }} 与采集日期分别展示，缺失日期不回填。</p><ul v-if="report.warnings.length"><li v-for="warning in report.warnings" :key="warning">{{ warning }}</li></ul></div></details>
      <div v-if="view.tab === 'delivery'" class="analytics-view">
        <div class="analytics-metrics"><button v-for="card in metricCards" :key="card.key" :data-testid="`analytics-metric-${card.key}`" class="analytics-metric" @click="selectMetric(card.title, card.metric)"><span>{{ card.title }}<span class="analytics-card-arrow" aria-hidden="true">↗</span></span><strong :class="{ 'analytics-null': card.metric.value === null }">{{ percentage(card.metric.value) }}</strong><small>分子 {{ number(card.metric.numerator) }} / 分母 {{ number(card.metric.denominator) }} {{ card.unit }}</small><small>缺失 {{ card.metric.missing }} 项 · 查看任务明细</small></button></div>
        <div class="analytics-counts"><span>执行任务 <b>{{ report.counts.total }}</b></span><span>已完成 <b>{{ report.counts.done }}</b></span><span>进行中 <b>{{ report.counts.inProgress }}</b></span><span>待办 <b>{{ report.counts.todo }}</b></span><span>受阻 <b>{{ report.counts.blocked }}</b></span><span>逾期 <b>{{ report.counts.overdue }}</b></span><span>待复核 <b>{{ report.counts.review }}</b></span><span>未排期 <b>{{ report.counts.unplanned }}</b></span><span>缺少真实完成日 <b>{{ report.counts.unknownActual }}</b> 项</span></div>
        <div v-if="!report.counts.total" class="analytics-empty">当前筛选没有执行任务。可调整工作分组、负责人或计划窗口查看其他任务。</div>
        <div class="analytics-chart-grid">
          <section class="analytics-panel"><header><div><h2>进度趋势</h2><p>选定基线参考 × 本机每日观测</p></div></header><AnalyticsChart :option="trendOption" label="计划与实际进度趋势。详细数值见下方趋势数据表。"/><p class="analytics-caption">{{ report.trend.message }}</p><p class="analytics-caption">最近实际采集：{{ stamp(latestCapture) }}；缺失采集日显示断点。</p><details class="analytics-data-table"><summary>查看趋势数据表（{{ report.trend.points.length }} 天）</summary><div class="analytics-table-scroll"><table><thead><tr><th>日期</th><th>基线计划参考</th><th>实际采集</th><th>采集时间</th></tr></thead><tbody><tr v-for="point in report.trend.points" :key="point.date"><td>{{ point.date }}</td><td>{{ percentage(point.planned) }}</td><td>{{ percentage(point.actual) }}</td><td>{{ stamp(point.capturedAt) }}</td></tr></tbody></table></div></details></section>
          <section class="analytics-panel"><header><div><h2>工作分组交付</h2><p>按执行任务数量计算完成率</p></div></header><AnalyticsChart :option="workstreamOption" label="各工作分组任务完成率。下方提供任务数量与可键盘操作的查看任务按钮。" @select="selectWorkstream"/><div class="analytics-stream-list"><div v-for="(stream, index) in report.workstreams" :key="stream.id"><div><b>{{ stream.name }}</b><small>{{ stream.done }} / {{ stream.total }} 项完成 · {{ percentage(stream.completion) }}</small></div><button class="analytics-link" :aria-label="`查看${stream.name}任务`" @click="selectWorkstream(index)">查看任务</button></div><p v-if="!report.workstreams.length" class="analytics-caption">当前筛选没有工作分组数据。</p></div></section>
        </div>
        <section class="analytics-panel"><header><div><h2>里程碑达成</h2><p>里程碑单列，正式验收通过且无需复核才计为达成；历史无凭证达成不计入。</p></div><button class="analytics-link" @click="selectMetric(report.project.isDemo ? '里程碑示例达成' : '里程碑达成', report.metrics.milestoneAchievement)">{{ percentage(report.metrics.milestoneAchievement.value) }} · {{ report.metrics.milestoneAchievement.numerator }} / {{ report.metrics.milestoneAchievement.denominator }}</button></header><div class="analytics-milestones"><article v-for="milestone in report.milestones" :key="milestone.id"><span class="analytics-badge" :class="{ achieved: milestone.achieved }">{{ milestone.achieved ? (report.project.isDemo ? '示例已达成' : '已达成') : '未达成' }}</span><h3>{{ milestone.title }}</h3><p>{{ milestone.owner || '未指定负责人' }} · {{ milestone.date || '未排期' }}</p><RouterLink class="analytics-link" :to="{name:'plan',query:{view:'milestones',milestone:milestone.id}}">查看里程碑 ↗</RouterLink></article></div><p v-if="!report.milestones.length" class="analytics-empty">当前筛选没有里程碑，可扩大计划窗口或调整筛选。</p></section>
      </div>
      <div v-if="view.tab === 'deviation'" class="analytics-view">
        <section class="analytics-panel"><header><div><h2>计划偏差</h2><p>以选定基线工作日历计算。已完成任务比较实际完成日；未完成任务比较当前计划结束日。</p></div><label class="analytics-inline-label">偏差状态<select v-model="view.deviationState" aria-label="统计偏差状态"><option value="">全部状态</option><option v-for="(label, key) in deviationLabels" :key="key" :value="key">{{ label }}</option></select></label></header><p class="analytics-caption">当前计划或基线计划与窗口重叠的任务均纳入；旧基线未保存工作分组时按当前任务归属。正数为延期，负数为提前；缺少真实完成日不会被当作按期完成。</p><div class="analytics-deviation-list"><article v-for="item in deviations.slice(0,deviationLimit)" :key="item.taskId" data-testid="analytics-deviation-row"><div class="analytics-deviation-main"><span class="analytics-badge" :class="item.state">{{ deviationLabels[item.state] }}</span><h3>{{ item.title }}</h3><p>{{ item.owner || '未指定负责人' }}</p></div><dl><div><dt>基线结束</dt><dd>{{ item.baselineEnd || '无记录' }}</dd></div><div><dt>当前计划</dt><dd>{{ item.currentEnd || '未排期' }}</dd></div><div><dt>实际完成</dt><dd>{{ item.actualEnd || '无真实日期' }}</dd></div><div><dt>工作日偏差</dt><dd :class="{ 'red-text': item.deltaDays !== null && item.deltaDays > 0 }">{{ item.deltaDays === null ? '暂无可计算数据' : `${item.deltaDays > 0 ? '+' : ''}${number(item.deltaDays)} 天` }}</dd></div></dl><button class="analytics-link" @click="selectTasks(item.title, [item.taskId])">查看任务明细</button></article></div><button v-if="deviations.length > deviationLimit" class="button" @click="deviationLimit += 50">加载更多偏差（{{ Math.min(deviationLimit,deviations.length) }} / {{ deviations.length }}）</button><p v-if="!deviations.length" class="analytics-empty">当前筛选没有偏差记录。可切换偏差状态或对比基线。</p></section>
      </div>
      <PersonnelAnalysis v-if="view.tab === 'personnel' && report.detailLevel !== 'summary'" :report="report" :state="view.personnel" @select="selectPersonnel"/>
      <div v-if="view.tab === 'capacity'" class="analytics-view">
        <section class="analytics-panel"><header><div><h2>每周资源负荷</h2><p>单任务按负责人 100% 分配，沿完整排期工作日均分工时后截取窗口。</p></div><label class="analytics-inline-label">容量计算方式<select v-model="view.filters.capacityMode" aria-label="容量计算方式"><option value="configured">已配置个人容量</option><option value="unknown">个人容量未知</option><option value="calendar">按日历满勤试算</option></select></label></header>
          <div class="analytics-capacity-notice" :class="{ trial: report.capacity.mode === 'calendar' }"><strong>{{ report.capacity.mode === 'calendar' ? '满勤试算 · 不代表真实个人容量' : report.capacity.mode === 'configured' ? '已配置个人容量 · 当前计划分析' : '个人可用工时未知 · 暂不计算负荷比' }}</strong><p>{{ report.capacity.label }}。{{ report.capacity.mode === 'calendar' ? '参考比按计划窗口内工作日 × 日工时计算，未考虑个人请假、兼职或其他项目投入。' : report.capacity.mode === 'configured' ? '个人日期例外优先；日历未确认或个人容量未配置时，保持未知。此处含已完成计划工时；自动预警仅检查未完成执行任务。' : '可切换已配置个人容量，或使用按日历满勤试算了解参考分配情况。' }}</p></div>
          <div class="analytics-week-pager"><button class="button" aria-label="查看前几周" :disabled="view.weekOffset === 0" @click="moveWeeks(-1)">上一组</button><span>{{ visibleWeeks[0]?.label || '无周数据' }}<template v-if="visibleWeeks.length > 1"> — {{ visibleWeeks.at(-1)?.label }}</template><small>共 {{ report.capacity.weeks.length }} 周 · 导出包含全部周</small></span><button class="button" aria-label="查看后几周" :disabled="view.weekOffset + weeksPerPage >= report.capacity.weeks.length" @click="moveWeeks(1)">下一组</button></div>
          <div class="analytics-capacity-grid" :style="{ '--week-count': visibleWeeks.length || 1 }"><div class="analytics-capacity-head"><span>负责人</span><span v-for="week in visibleWeeks" :key="week.start">{{ week.label }}<small>{{ week.start.slice(5) }} 起</small></span></div><div v-for="member in report.capacity.members" :key="member.id" class="analytics-capacity-row"><b>{{ member.name }}</b><template v-for="week in visibleWeeks" :key="week.start"><button v-if="cellFor(member, week.start)" data-testid="analytics-capacity-cell" class="analytics-capacity-cell" :class="cellFor(member, week.start)!.status" :aria-label="`${member.name} ${week.label} 分配 ${number(cellFor(member, week.start)!.plannedHours)} 小时，${capacityLabels[cellFor(member, week.start)!.status]}，查看任务`" @click="selectCapacity(member.name, week.label, cellFor(member, week.start)!)"><strong>{{ number(cellFor(member, week.start)!.plannedHours) }}<small> 小时</small></strong><span>{{ capacityLabels[cellFor(member, week.start)!.status] }}</span><small>{{ cellFor(member, week.start)!.ratio === null ? '负荷比未知' : `${report.capacity.mode === 'configured' ? '负荷' : '参考负荷'} ${percentage(cellFor(member, week.start)!.ratio)}` }}</small><small>可用 {{ number(cellFor(member, week.start)!.availableHours) }}{{ cellFor(member, week.start)!.availableHours === null ? '' : ' 小时' }}</small></button><span v-else class="analytics-capacity-empty">暂无数据</span></template></div></div>
          <p v-if="!report.capacity.members.length" class="analytics-empty">当前筛选没有可分配至负责人的任务。请查看未分配项或调整筛选。</p>
        </section>
        <section class="analytics-panel"><header><div><h2>未分配任务 <span class="analytics-subtle">{{ report.capacity.unallocated.length }} 项</span></h2><p>缺少排期、估算或负责人时，不将未知工时记为零。</p></div></header><div class="analytics-unallocated"><article v-for="item in report.capacity.unallocated.slice(0,unallocatedLimit)" :key="`${item.taskId}-${item.reason}`"><div><h3>{{ item.title }}</h3><p>{{ item.reason }}</p></div><button class="analytics-link" @click="selectTasks('未分配任务', [item.taskId])">查看任务明细</button></article></div><button v-if="report.capacity.unallocated.length > unallocatedLimit" class="button" @click="unallocatedLimit += 50">加载更多未分配任务</button><p v-if="!report.capacity.unallocated.length" class="analytics-empty">当前筛选没有未分配任务。</p></section>
      </div>
      <section v-if="view.selection" ref="detailSection" tabindex="-1" class="analytics-panel analytics-task-details" aria-labelledby="analytics-details-title"><header><div><h2 id="analytics-details-title">任务明细</h2><p>{{ view.selection.title }} · {{ selectedTasks.length }} 项</p></div><button class="analytics-link" @click="view.selection = null">收起明细</button></header><div class="analytics-task-list"><article v-for="item in selectedTasks.slice(0,detailLimit)" :key="item.id" data-testid="analytics-task-row"><template v-if="item.task"><div><small>{{ item.task.wbs }} · {{ item.task.owner || '未指定负责人' }}</small><h3>{{ item.task.title }}</h3><p>{{ taskStatusLabels[item.task.status] }} · 进度 {{ item.task.progress }}% · 估算 {{ number(item.task.effortHours) }} 小时</p><p>计划 {{ item.task.start || '未排期' }} — {{ item.task.end || '未排期' }}<span v-if="item.hours !== undefined"> · 本周分摊 {{ number(item.hours) }} 小时</span></p><p v-if="item.task.status === 'done' && !item.task.actualEnd">缺少真实完成日，无法判定实际偏差。</p><div v-if="view.tab === 'personnel' && personnelTimings.get(item.id)" class="personnel-timing"><p><strong>{{ personnelStateLabels[personnelTimings.get(item.id)!.state] }}</strong></p><p>当前截止日 {{ item.task.end || '缺失' }} · 实际完成日 {{ item.task.actualEnd || '无记录' }}</p><p>参照截止日 {{ personnelTimings.get(item.id)!.referenceEnd || '缺失' }} · 来源：{{ referenceSourceLabels[personnelTimings.get(item.id)!.referenceSource] }}</p><p>统计基准日 {{ report.dataAsOf }}</p></div></div><RouterLink class="analytics-link" :to="{ name: 'task-detail', params: { taskId: item.task.id }, query: { from: 'analytics' } }">打开任务详情</RouterLink></template><template v-else-if="item.deviation?.canOpen"><div><small>{{ item.deviation.owner || '未指定负责人' }} · {{ deviationLabels[item.deviation.state] }}</small><h3>{{ item.deviation.title }}</h3><p>此任务参与基线偏差对比，不计入当前执行任务指标。</p></div><RouterLink class="analytics-link" :to="{ name: 'task-detail', params: { taskId: item.id }, query: { from: 'analytics' } }">打开任务详情</RouterLink></template><template v-else><div><h3>{{ report.milestones.find(m => m.id === item.id)?.title || report.deviations.find(d => d.taskId === item.id)?.title || '历史关联条目' }}</h3><p>里程碑与历史基线条目单独展示，不计入普通执行任务。</p><RouterLink v-if="report.milestones.some(m => m.id === item.id)" class="analytics-link" :to="{name:'plan',query:{view:'milestones',milestone:item.id}}">查看里程碑 ↗</RouterLink></div></template></article></div><button v-if="selectedTasks.length > detailLimit" class="button" @click="detailLimit += 50">加载更多任务明细</button><p v-if="!selectedTasks.length" class="analytics-empty">此指标当前没有关联任务。可调整筛选或查看指标说明。</p></section>
      <footer class="analytics-footer"><span>{{ report.project.isDemo ? 'DEMO · ' : '' }}生成于 {{ stamp(report.generatedAt) }}</span><span>统计口径 {{ report.metricVersion }} · 当前项目数据</span></footer>
    </template>
  </section>
</template>
