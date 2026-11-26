<script setup lang="ts">
import { computed } from 'vue';
import type { AnalyticsReport, PersonnelMember, PersonnelMetricKey } from '../../../../shared/src/analytics';
import PersonnelRate from './PersonnelRate.vue';
import { availabilityLabels, personnelMetricLabels, personnelGroupLabels, personnelNotice, personnelSelectionIds, sortedPersonnel } from './personnel';
import type { PersonnelSelection, PersonnelViewState } from './personnel';
import './personnel.css';
const props = defineProps<{ report: AnalyticsReport; state: PersonnelViewState }>();
const emit = defineEmits<{ select: [title: string, ids: string[], selection: PersonnelSelection] }>();
const rows = computed(() => sortedPersonnel(props.report.personnel.members, props.state));
const mainKeys: PersonnelMetricKey[] = ['completion', 'overdue', 'late'];
const allKeys: PersonnelMetricKey[] = [...mainKeys, 'onTime'];
function select(title: string, selection: PersonnelSelection) { emit('select', title, personnelSelectionIds(props.report.personnel, selection), selection); }
function metricSelection(key: PersonnelMetricKey, part: 'numerator' | 'denominator' | 'missing', member?: PersonnelMember) {
  const labels = { numerator: '分子任务', denominator: '分母任务', missing: '数据缺失任务' };
  select(`${member?.name ?? '当前项目'} · ${personnelMetricLabels[key]} · ${labels[part]}`, { memberId: member?.id, metric: key, part });
}
function toggle(member: PersonnelMember) {
  const key = member.id ?? '';
  props.state.expanded = props.state.expanded.includes(key) ? props.state.expanded.filter(id => id !== key) : [...props.state.expanded, key];
}
</script>
<template>
  <div class="analytics-view personnel-analysis">
    <div class="analytics-notice personnel-notice"><div><strong>统计基准日 {{ report.dataAsOf }} · {{ report.project.isDemo ? 'DEMO 示例观察日' : 'Asia/Shanghai' }}</strong><p>{{ personnelNotice }}</p><p>未完成任务按当前计划判断逾期；已完成任务参照所选基线，无对应条目时使用完成时冻结日期。当天到期不算逾期。</p></div></div>
    <div class="analytics-metrics">
      <button class="analytics-metric" data-testid="personnel-total" @click="select('当前项目 · 全部执行任务', {})"><span>执行任务总数 ↗</span><strong>{{ report.personnel.summary.counts.total }}</strong><small>{{ report.personnel.members.length }} 位负责人／分组 · 查看全部任务</small></button>
      <article v-for="key in mainKeys" :key="key" class="analytics-metric personnel-summary-card" :data-testid="`personnel-metric-${key}`"><span>{{ personnelMetricLabels[key] }}</span><PersonnelRate :metric="report.personnel.summary.metrics[key]" :label="personnelMetricLabels[key]" @select="part => metricSelection(key, part)"/><small>缺失 {{ report.personnel.summary.metrics[key].missing }} 项 · 点击查看分子任务</small></article>
    </div>
    <section class="analytics-panel">
      <header><div><h2>人员任务概览</h2><p>按当前负责人归集，点击数量查看任务，展开查看完整口径与数据缺失。</p></div><div class="personnel-sort"><label>排序指标<select v-model="state.sortBy" aria-label="人员排序指标"><option value="default">成员顺序</option><option value="total">任务数</option><option v-for="key in mainKeys" :key="key" :value="key">{{ personnelMetricLabels[key] }}</option></select></label><label>排序方向<select v-model="state.direction" aria-label="人员排序方向" :disabled="state.sortBy === 'default'"><option value="desc">降序</option><option value="asc">升序</option></select></label></div></header>
      <p v-if="!report.personnel.summary.counts.total" class="analytics-empty">当前筛选没有执行任务。可调整工作分组、负责人或计划窗口；无任务成员的比例保持未知。</p>
      <table class="personnel-table"><caption class="personnel-sr-only">人员任务分析，可展开各人员指标并查看任务</caption><thead><tr><th scope="col">负责人</th><th scope="col">任务数</th><th v-for="key in mainKeys" :key="key" scope="col">{{ personnelMetricLabels[key] }}</th><th scope="col">明细</th></tr></thead>
        <tbody v-for="member in rows" :key="member.id ?? ''" :data-member-id="member.id ?? ''" data-testid="personnel-row">
          <tr class="personnel-main-row">
            <th scope="row" class="personnel-name"><button class="analytics-link" @click="select(`${member.name} · 全部执行任务`, { memberId: member.id })">{{ member.name }}</button><small v-if="member.availability !== 'active'">{{ availabilityLabels[member.availability] }}</small></th>
            <td data-label="任务数"><button class="analytics-link" :aria-label="`查看${member.name}全部 ${member.counts.total} 项任务`" @click="select(`${member.name} · 全部执行任务`, { memberId: member.id })">{{ member.counts.total }} 项</button></td>
            <td v-for="key in mainKeys" :key="key" :data-label="personnelMetricLabels[key]"><PersonnelRate :metric="member.metrics[key]" :label="`${member.name} · ${personnelMetricLabels[key]}`" @select="part => metricSelection(key, part, member)"/></td>
            <td data-label="明细"><button class="analytics-link" :aria-expanded="state.expanded.includes(member.id ?? '')" :aria-label="`${state.expanded.includes(member.id ?? '') ? '收起' : '展开'}${member.name}指标`" @click="toggle(member)">{{ state.expanded.includes(member.id ?? '') ? '收起指标' : '展开指标' }}</button></td>
          </tr>
          <tr v-if="state.expanded.includes(member.id ?? '')" class="personnel-expanded-row"><td colspan="6">
            <div class="personnel-expanded"><h3>{{ member.name }} · 指标明细</h3><div class="personnel-detail-metrics"><section v-for="key in allKeys" :key="key"><h4>{{ personnelMetricLabels[key] }}</h4><PersonnelRate :metric="member.metrics[key]" :label="`${member.name} · ${personnelMetricLabels[key]}`" detailed @select="part => metricSelection(key, part, member)"/></section></div>
              <p class="personnel-state-note">待办、进行中、已完成互斥；受阻、待复核与日期缺失可以重叠，不可相加。缺少实际日和参照日的同一任务，指标缺失总数仅计一次。</p>
              <div class="personnel-group-links"><button v-for="(label, key) in personnelGroupLabels" :key="key" class="analytics-link" @click="select(`${member.name} · ${label}`, { memberId: member.id, group: key })">{{ label }} {{ member.counts[key] }} 项</button></div>
            </div>
          </td></tr>
        </tbody>
      </table>
      <p v-if="!rows.length" class="analytics-empty">当前筛选没有成员或历史负责人。可调整负责人筛选或在成员与设置中添加成员。</p>
    </section>
  </div>
</template>
