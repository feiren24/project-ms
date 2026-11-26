<script setup lang="ts">
import { milestoneAttention, milestoneSummaryLabel } from '../../utils/milestone-presentation';
import { computed, toRef } from 'vue';
import { useProjectView } from '../../stores/project-scope';
import { useAuthStore } from '../../stores/auth';
import Icon from '../../components/Icon.vue';
import ActivityPanel from '../activities/ActivityPanel.vue';
import type { PublicProjectOverview as ProjectOverview } from '../../../../shared/src/contracts';
import type { DetailRequest } from '../../types';
const props = defineProps<{ data: ProjectOverview; refreshing: boolean }>();
const emit = defineEmits<{ inspect: [value: DetailRequest]; refresh: [] }>();
const activeTab = toRef(useProjectView('overview', () => ({ activeTab: 'all' })), 'activeTab');
const auth = useAuthStore();
const canViewRisks = computed(() => auth.capabilities(props.data.project.id).risks);
const visibleRisks = computed(() => canViewRisks.value ? props.data.risks || [] : []);
const attentionTabs = computed(() => [{id:'all',name:'全部'},{id:'overdue',name:'逾期'},{id:'review',name:'待验收'},...(canViewRisks.value ? [{id:'risk',name:'风险'}] : [])]);
const isDemo = computed(() => props.data.project.isDemo);
const taskCount = (id: string, status?: string) => props.data.tasks.filter(t => t.workstreamId === id && (!status || t.status === status)).length;
const completed = (id: string) => taskCount(id) ? Math.round(taskCount(id, 'done') / taskCount(id) * 100) : 0;
const overdue = computed(() => props.data.tasks.filter(t => t.status !== 'done' && !!t.due && t.due < props.data.project.asOf));
const upcoming = computed(() => props.data.milestones.filter(m => !['accepted','cancelled'].includes(m.milestoneState || '') && m.date >= props.data.project.asOf && Date.parse(m.date) - Date.parse(props.data.project.asOf) <= 14 * 86400000).sort((a,b) => a.date.localeCompare(b.date)).slice(0,4));
const attentionMilestones = computed(() => props.data.milestones.filter(m => !!milestoneAttention(m)));
const streamColor = (color: string) => color === 'purple' ? 'violet' : color;
const monthDay = (date: string) => date.slice(5).replace('-', '.');
const offset = (date: string) => Math.max(0, Math.min(100, (Date.parse(date) - Date.parse(props.data.project.start)) / Math.max(1, Date.parse(props.data.project.end) - Date.parse(props.data.project.start)) * 100));
const segment = (start: string, end: string) => ({ left: `${offset(start)}%`, width: `${Math.max(5, offset(end) - offset(start))}%` });
const months = computed(() => {
  const start = new Date(props.data.project.start + 'T00:00:00Z'), end = new Date(props.data.project.end + 'T00:00:00Z');
  const count = (end.getUTCFullYear()-start.getUTCFullYear())*12+end.getUTCMonth()-start.getUTCMonth();
  const step = Math.max(1,Math.ceil(count/4));
  const result = [{ label: `${start.getUTCMonth()+1} 月`, left: 0 }];
  for (let i=step;i<=count;i+=step) { const date = new Date(Date.UTC(start.getUTCFullYear(),start.getUTCMonth()+i,1));result.push({label:`${date.getUTCMonth()+1} 月`,left:offset(date.toISOString().slice(0,10))}); }
  return result;
});
const attention = computed(() => {
  const items = [
    ...overdue.value.map(t => ({ id: t.id, title: t.title, type: 'overdue', label: '任务逾期', subtitle: `${t.owner} · 原定 ${monthDay(t.due)} 完成`, kind: 'tasks' as const, filter: t.id })),
    ...attentionMilestones.value.map(m => ({ id:m.id,title:m.title,...milestoneAttention(m)!,kind:'milestones' as const,filter:m.id })),
    ...visibleRisks.value.filter(r => (['high','critical'].includes(r.level || '') || r.reviewOverdue)).map(r => ({ id: r.id, title: r.title, type: 'risk', label: r.reviewOverdue ? '复查逾期' : r.level === 'critical' ? '严重风险' : '高风险', subtitle: `${r.owner} · ${r.reviewOverdue ? '需要复查风险' : '需要跟进应对措施'}`, kind: 'risks' as const, filter: r.id })),
  ];
  return activeTab.value === 'all' ? [...items.filter(i => i.type === 'overdue').slice(0,2),...items.filter(i => i.kind === 'milestones').slice(0,1),...items.filter(i => i.type === 'risk').slice(0,1)] : items.filter(i => i.type === activeTab.value);
});
const statusText = (status: string) => ({ upcoming: '即将到来', review: '待验收', done: '已完成' }[status]);
const rate = computed(() => props.data.summary.completionRate === null ? '—' : props.data.summary.completionRate.toFixed(1));
</script>

<template>
  <div class="overview-page">
    <section class="page-heading">
      <div><div class="eyebrow">PROJECT OVERVIEW <span></span> 每一步，都向目标靠近</div><div class="heading-title"><h1>项目总览</h1><span class="status-badge"><span></span> {{ data.summary.totalTasks ? '计划执行中' : '待安排任务' }} <small v-if="isDemo">示例</small></span></div><p>{{ data.project.name }} <span class="subtitle-divider">/</span> {{ data.project.description }}</p></div>
      <div class="heading-actions"><button class="button date-button" @click="emit('inspect', { kind: 'project', title: '项目时间与数据说明' })"><Icon name="calendar" :size="16"/>{{ monthDay(data.project.start) }} — {{ monthDay(data.project.end) }}<Icon name="down" :size="12"/></button><button class="icon-button refresh-button" :class="{ spinning: refreshing }" :disabled="refreshing" aria-label="刷新首页" @click="emit('refresh')"><Icon name="refresh" :size="17"/></button><button class="button primary" @click="emit('inspect', { kind: 'plan', title: '完整计划' })">查看完整计划<Icon name="arrow" :size="16"/></button></div>
    </section>
    <div v-if="isDemo" class="demo-strip"><span class="demo-label">{{ isDemo ? 'DEMO' : '本机项目' }}</span><span>{{ isDemo ? '当前为首页交互预览，进度、任务及人员均为示例数据。' : '仅显示本项目已保存的任务与计划。尚未配置的内容保持为空。' }}</span><span class="snapshot-label">{{ isDemo ? '示例快照' : '统计基准日' }} <b>{{ data.project.asOf.replaceAll('-','.') }}</b></span></div>

    <section class="metric-grid" :class="{ 'collaboration-metrics': !canViewRisks }" aria-label="项目关键指标">
      <button class="metric-card completion-card" @click="emit('inspect', { kind: 'tasks', title: '任务完成情况', filter: 'done' })"><div class="metric-top"><span>任务完成率</span><span class="metric-icon blue"><Icon name="task" :size="19"/></span></div><div class="metric-value">{{ rate }}<small>%</small><span class="mini-ring" :style="{ '--progress': `${data.summary.completionRate ?? 0}%` }"><Icon name="check" :size="13"/></span></div><div class="metric-bottom"><span>已完成 <b>{{ data.summary.completedTasks }}</b> / {{ data.summary.totalTasks }} 项任务</span><span class="metric-link">查看 <Icon name="chevron" :size="12"/></span></div><div class="metric-track"><i :style="{ width: `${data.summary.completionRate ?? 0}%` }"></i></div></button>
      <button class="metric-card" @click="emit('inspect', { kind: 'milestones', title: '未来两周 · 近期里程碑' })"><div class="metric-top"><span>近期里程碑</span><span class="metric-icon violet"><Icon name="flag" :size="18"/></span></div><div class="metric-value">{{ data.summary.upcomingMilestones }}<small>项</small><div class="milestone-mini"><i></i><span></span><i></i><span></span><i></i></div></div><div class="metric-bottom"><span>未来两周计划交付</span><span class="metric-link">查看 <Icon name="chevron" :size="12"/></span></div></button>
      <button class="metric-card" @click="emit('inspect', { kind: 'tasks', title: '需要跟进的逾期任务', filter: 'overdue' })"><div class="metric-top"><span>逾期任务</span><span class="metric-icon orange"><Icon name="clock" :size="19"/></span></div><div class="metric-value">{{ data.summary.overdueTasks }}<small>项</small><span class="metric-status orange-text">需要跟进</span></div><div class="metric-bottom"><span>查看原因，推进下一步</span><span class="metric-link">查看 <Icon name="chevron" :size="12"/></span></div></button>
      <button v-if="canViewRisks" class="metric-card" @click="emit('inspect', { kind: 'risks', title: '高风险事项', filter: 'high' })"><div class="metric-top"><span>高风险事项</span><span class="metric-icon red"><Icon name="shield" :size="19"/></span></div><div class="metric-value">{{ data.summary.highRisks }}<small>项</small><span class="metric-status red-text">优先处理</span></div><div class="metric-bottom"><span>明确责任，及时化解风险</span><span class="metric-link">查看 <Icon name="chevron" :size="12"/></span></div></button>
    </section>

    <div class="dashboard-row primary-row">
      <section class="panel roadmap-panel">
        <div class="panel-heading"><div><h2>交付路线 <span class="subtle-count">{{ data.workstreams.length }} 个工作分组</span></h2><p>从基础建设到业务验证，保持全局节奏</p></div><button class="text-button" @click="emit('inspect', { kind: 'plan', title: '全部工作分组 · 交付路线' })">查看计划<Icon name="arrow" :size="15"/></button></div>
        <div class="roadmap" aria-label="项目交付路线摘要">
          <div class="roadmap-head"><span>工作分组</span><div class="months"><span v-for="month in months" :key="month.label" :style="{ left: `${month.left}%` }">{{ month.label }}</span></div></div>
          <div v-for="(stream, index) in data.workstreams" :key="stream.id" class="roadmap-row"><button class="roadmap-label" @click="emit('inspect', { kind: 'workstream', title: stream.name, filter: stream.id })"><i :class="`dot-${streamColor(stream.color)}`"></i>{{ stream.name }}</button><div class="roadmap-lane"><span v-for="month in months.slice(1)" :key="month.label" class="grid-line" :style="{ left: `${month.left}%` }"></span><span v-if="data.project.asOf >= data.project.start && data.project.asOf <= data.project.end" class="snapshot-line" :style="{ left: `${offset(data.project.asOf)}%` }"></span><button v-if="taskCount(stream.id) && stream.start && stream.end" class="roadmap-bar" :class="streamColor(stream.color)" :style="segment(stream.start, stream.end)" :aria-label="`${stream.name}，${stream.start} 至 ${stream.end}，查看摘要`" @click="emit('inspect', { kind: 'workstream', title: stream.name, filter: stream.id })"><span class="bar-completed" :style="{ width: `${completed(stream.id)}%` }"></span><span class="bar-caption">{{ completed(stream.id) }}%</span></button></div></div>
          <div class="roadmap-foot"><span><i class="legend-dot"></i> 当前计划 <i class="legend-line"></i> {{ isDemo ? '示例快照日' : '统计基准日' }}</span><span>目标交付 <b>{{ monthDay(data.project.end) }}</b><Icon name="flag" :size="12"/></span></div>
        </div>
      </section>
      <section class="panel attention-panel">
        <div class="panel-heading"><div><h2>需要你处理 <span class="count-pill">{{ data.summary.overdueTasks + visibleRisks.filter(r => ['high','critical'].includes(r.level || '') || r.reviewOverdue).length + attentionMilestones.length }}</span></h2><p>把注意力放在真正影响交付的事情上</p></div><button class="icon-button" aria-label="查看全部待处理" @click="emit('inspect', { kind: 'attention', title: '全部待处理事项' })"><Icon name="arrow" :size="17"/></button></div>
        <div class="attention-tabs" role="tablist" aria-label="待处理事项筛选"><button v-for="tab in attentionTabs" :key="tab.id" role="tab" :aria-selected="activeTab === tab.id" :class="{ selected: activeTab === tab.id }" @click="activeTab = tab.id">{{ tab.name }}</button></div>
        <div class="attention-list"><button v-for="item in attention" :key="item.id" class="attention-item" @click="emit('inspect', { kind: item.kind, title: item.title, filter: item.filter })"><span class="attention-icon" :class="item.type"><Icon :name="item.type === 'overdue' ? 'clock' : item.kind === 'milestones' ? 'flag' : 'shield'" :size="17"/></span><span class="attention-copy"><span class="attention-title">{{ item.title }}</span><small>{{ item.subtitle }}</small></span><span class="attention-status" :class="item.type">{{ item.label }}</span><Icon name="chevron" :size="13"/></button><p v-if="!attention.length" class="inline-empty">这一分类暂时没有待处理事项。</p></div>
      </section>
    </div>

    <div class="dashboard-row secondary-row">
      <section class="panel streams-panel">
        <div class="panel-heading"><div><h2>工作分组进展</h2><p>每一项进展，都在汇聚成共同的成果</p></div><button class="text-button" @click="emit('inspect', { kind: 'tasks', title: '全部任务' })">全部任务<Icon name="arrow" :size="15"/></button></div>
        <div class="stream-table" role="table" aria-label="工作分组任务进展"><div class="stream-table-head" role="row"><span role="columnheader">工作分组 / 负责人</span><span role="columnheader">任务进展</span><span role="columnheader">完成率</span><span role="columnheader">状态</span></div>
          <button v-for="stream in data.workstreams" :key="stream.id" class="stream-table-row" role="row" @click="emit('inspect', { kind: 'workstream', title: stream.name, filter: stream.id })"><span class="stream-name" role="cell"><span class="stream-icon" :class="streamColor(stream.color)" :data-icon="stream.icon || 'layers'"><Icon :name="stream.icon || 'layers'" :size="18"/></span><span><b>{{ stream.name }}</b><small>{{ stream.owner }}</small></span></span><span class="stream-progress" role="cell"><span class="stream-progress-track"><i :class="`fill-${streamColor(stream.color)}`" :style="{ width: `${completed(stream.id)}%` }"></i></span><small>{{ taskCount(stream.id, 'done') }} / {{ taskCount(stream.id) }} 项完成</small></span><b class="stream-percent" role="cell">{{ completed(stream.id) }}<small>%</small></b><span role="cell" class="stream-state" :class="{ inactive: stream.active === false }"><i></i>{{ stream.active === false ? '已停用' : taskCount(stream.id) ? '进行中' : '待安排' }}<Icon name="chevron" :size="13"/></span></button>
        </div>
      </section>
      <div class="right-stack">
        <section class="panel milestones-panel"><div class="panel-heading"><div><h2>接下来两周</h2><p>留意关键节点，提前做好准备</p></div><span class="calendar-tile"><Icon name="calendar" :size="18"/></span></div><p v-if="!upcoming.length" class="inline-empty">暂无近期里程碑，明确交付节点后可在完整计划中查看。</p><div class="milestone-list"><button v-for="milestone in upcoming" :key="milestone.id" class="milestone-item" @click="emit('inspect', { kind: 'milestones', title: milestone.title, filter: milestone.id })"><span class="milestone-date"><b>{{ milestone.date.slice(8) }}</b><small>{{ Number(milestone.date.slice(5, 7)) }} 月</small></span><span class="milestone-event"><span>{{ milestone.title }}</span><small>{{ data.workstreams.find(w => w.id === milestone.workstreamId)?.name }}</small></span><span class="milestone-state" :class="{ review: milestone.milestoneState === 'submitted' }">{{ milestoneSummaryLabel(milestone) }}</span></button></div></section>
        <ActivityPanel :project-id="data.project.id" :refresh-key="data" @open="activity => emit('inspect', {kind:'activity',title:'项目动态',activity})"/>
      </div>
    </div>
    <footer class="page-footer"><span><span class="footer-brand-dot"></span> 清晰的计划，让好活如期发生。</span><button @click="emit('inspect', { kind: 'goals', title: '数据来源与阶段目标' })">{{ isDemo ? '阶段目标来源' : '查看项目目标' }} <Icon name="arrow" :size="13"/></button></footer>
  </div>
</template>

<style scoped>
@media (min-width: 768px) {
  .metric-grid.collaboration-metrics { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
</style>
