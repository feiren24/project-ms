<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from './Icon.vue';
import { milestoneAttention, milestoneSummaryLabel } from '../utils/milestone-presentation';
import { useAuthStore } from '../stores/auth';
const auth = useAuthStore();
import { RouterLink } from 'vue-router';
import type { PublicProjectOverview as ProjectOverview } from '../../../shared/src/contracts';
import type { DetailRequest } from '../types';
import { emptySearchState, type SearchState } from '../stores/search-navigation';
const props = defineProps<{ request: DetailRequest; data: ProjectOverview; searchState?: SearchState; searchBusy?: boolean; searchRefreshing?: boolean; searchError?: string }>();
const emit = defineEmits<{ close: []; 'update:searchState': [state: SearchState]; 'open-task': [id: string]; 'retry-search': [] }>();
const dialog = ref<HTMLDialogElement>();
const content = ref<HTMLElement>();
const localState = ref<SearchState>(emptySearchState());
const state = computed(() => props.searchState || localState.value);
function updateState(patch: Partial<SearchState>) { const value = { ...state.value, ...patch }; localState.value = value; emit('update:searchState', value); }
const query = computed({ get: () => state.value.query, set: query => { updateState({ query, scrollTop: 0, selectedTaskId: '' }); if (content.value) content.value.scrollTop = 0; } });
function openTask(event: MouseEvent, id: string) {
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  if (props.searchBusy) return;
  updateState({ selectedTaskId: id, scrollTop: content.value?.scrollTop || 0 });
  emit('open-task', id);
}
async function restoreSearch() {
  if (props.request.kind !== 'search') return;
  await nextTick();
  const target = dialog.value?.querySelector<HTMLElement>(`[data-search-task="${CSS.escape(state.value.selectedTaskId)}"]`);
  (target || dialog.value?.querySelector<HTMLInputElement>('.drawer-search input'))?.focus({ preventScroll: true });
  if (content.value) content.value.scrollTop = state.value.scrollTop;
}
const canViewRisks = computed(() => auth.capabilities(props.data.project.id).risks);
const filter = computed(() => props.request.filter);
const tasks = computed(() => props.data.tasks.filter(t => {
  if (props.request.kind === 'search') return query.value.trim() && `${t.title} ${t.owner} ${t.id}`.toLowerCase().includes(query.value.toLowerCase().trim());
  if (props.request.kind === 'attention') return t.status !== 'done' && !!t.due && t.due < props.data.project.asOf;
  if (props.request.kind === 'workstream') return t.workstreamId === filter.value;
  if (filter.value === 'done') return t.status === 'done';
  if (filter.value === 'overdue') return t.status !== 'done' && !!t.due && t.due < props.data.project.asOf;
  if (filter.value === 'pending') return t.status !== 'done';
  if (filter.value) return t.id === filter.value;
  return true;
}));
const risks = computed(() => (canViewRisks.value ? props.data.risks || [] : []).filter(r => props.request.kind === 'attention' ? (['high','critical'].includes(r.level || '') || r.reviewOverdue) : props.request.kind === 'search' ? query.value.trim() && `${r.title} ${r.description}`.includes(query.value.trim()) : !filter.value || r.id === filter.value || r.level === filter.value || (filter.value === 'high' && r.level === 'critical')));
const milestones = computed(() => props.data.milestones.filter(m => props.request.kind === 'attention' ? !!milestoneAttention(m) : filter.value ? m.id === filter.value : !['accepted','cancelled'].includes(m.milestoneState || '')));
const stream = computed(() => props.data.workstreams.find(s => s.id === filter.value));
const status = (s: string) => ({ todo: '待办', in_progress: '进行中', done: '已完成', upcoming: '即将到来', review: '待验收' }[s] || s);
function close() { dialog.value?.close(); }
onMounted(() => { dialog.value?.showModal(); void restoreSearch(); });
watch(() => props.data, () => { if (props.request.kind === 'search') void restoreSearch(); });
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
  <dialog ref="dialog" class="detail-dialog" aria-labelledby="drawer-title" @close="emit('close')" @click="e => { if (e.target === dialog) close(); }">
    <div class="drawer-shell">
      <header class="drawer-header"><div><span class="eyebrow">PROJECT INSIGHT</span><h2 id="drawer-title">{{ request.title }}</h2></div><button class="icon-button" aria-label="关闭详情" @click="close"><Icon name="close"/></button></header>
      <div v-if="data.project.isDemo" class="drawer-demo"><span class="demo-label">DEMO</span>示例项目数据 · 示例快照 {{ data.project.asOf }}</div>
      <div ref="content" class="drawer-content" @scroll="request.kind === 'search' && updateState({ scrollTop: content?.scrollTop || 0 })">
        <template v-if="request.kind === 'project'"><div class="project-detail-logo"><Icon name="folder" :size="30"/></div><h3>{{ data.project.name }}</h3><p class="drawer-description">{{ data.project.description }}</p><dl class="detail-fields"><div><dt>项目性质</dt><dd>{{ data.project.isDemo ? '示例项目' : '普通项目' }}</dd></div><div><dt>目标窗口</dt><dd>{{ data.project.start }} — {{ data.project.end }}</dd></div><div><dt>{{ data.project.isDemo ? '示例快照日' : '统计基准日' }}</dt><dd>{{ data.project.asOf }}</dd></div><div><dt>当前范围</dt><dd>项目总览、完整计划、工作分组、任务管理、统计分析、风险管理与成员设置</dd></div><div><dt>{{ auth.session?.legacyDemo ? '体验身份' : '当前账号' }}</dt><dd>{{ auth.session?.legacyDemo ? '周亦安 · 虚构项目负责人' : auth.user?.name }}</dd></div></dl><div class="detail-callout"><Icon name="info" :size="19"/><p>数据保存在运行本系统的设备上。任务变更会同步到完整计划、项目总览和统计分析。账号权限由当前项目角色决定；各项目独立保留任务和进度。站内通知用于个人协作提醒。项目负责人或管理员可在“成员与设置 → 通知与集成”接入飞书群机器人；只有明确测试或启用的规则才会发送飞书消息。</p></div><h4>项目协作权限</h4><p class="drawer-description">项目负责人和项目管理员拥有全部项目操作权限。项目成员可创建并分派任务、执行自己的任务和验收指定成果。只读成员仅浏览，不可修改、导出或标记通知已读。管理人员自验会记录理由及实际操作者。移除成员前须先移交当前责任，历史记录保留。</p><h4>已确认的导航</h4><div class="scope-chips"><span v-for="name in ['项目总览','完整计划','工作分组','任务管理','统计分析','风险中心','成员与设置']" :key="name">{{ name }}</span></div></template>
        <template v-else-if="request.kind === 'goals' && !data.project.isDemo"><h3>{{ data.project.name }}</h3><p class="drawer-description">{{ data.project.description || '尚未填写项目目标，可在成员与设置中维护。' }}</p><div class="detail-callout"><p>计划日期：{{ data.project.start }} → {{ data.project.end }}。当前仅显示本项目已保存的工作内容。</p></div></template><template v-else-if="request.kind === 'goals'"><span class="section-kicker">第一阶段 · 2026</span><h3>跑通业务闭环和商业模式</h3><p class="drawer-description">目标范围参考原始文件。首页进度与人员是独立示例，不代表这些目标已经完成。</p><ol class="goal-list"><li>产研完成 MVP 完整版本，技术底座、业务模块、后台上线。</li><li>完成多批真实订单闭环验证。</li><li>拿到付费客户样本，验证商业模式可行性。</li><li>沉淀可复用的劳动者职业信用数据。</li><li>明确后续迭代与规模化扩张路径。</li></ol><div class="scope-stats"><div><b>8</b><span>系统底座类别</span></div><div><b>23</b><span>用工方模块</span></div><div><b>28</b><span>求职者模块</span></div></div><h4>范围依据</h4><p class="source-file"><Icon name="book" :size="18"/>我有好活第一阶段目标.csv</p><p class="drawer-description">原始文件没有逐项排期、实际状态或明确的个人任务分配。收费模式、运营后台及待细化的运营范围一并保留。</p><div class="detail-callout"><Icon name="info" :size="19"/><p>阶段边界：生态连接器首批 3 个核心场景适配器；多语言先完成基础框架与英语 Demo 验证。</p></div></template>
        <template v-else-if="request.kind === 'plan'"><p class="drawer-description">这里是首页的交付路线摘要。完整甘特图与排期调整可从侧栏“完整计划”进入。</p><article v-for="s in data.workstreams" :key="s.id" class="detail-list-card"><div class="detail-card-title"><span class="stream-dot" :class="`dot-${s.color}`"></span><h3>{{ s.name }}</h3></div><p>{{ s.description }}</p><div class="detail-card-meta"><span>{{ s.owner }}</span><span>{{ s.start.slice(5) }} → {{ s.end.slice(5) }}</span></div></article></template>

        <template v-else>
          <div v-if="request.kind === 'search'" class="drawer-search"><Icon name="search" :size="19"/><input v-model="query" :aria-label="canViewRisks ? '搜索任务或风险' : '搜索任务或负责人'" :placeholder="canViewRisks ? '输入任务、负责人或风险关键词' : '输入任务或负责人关键词'" autofocus/><button v-if="query" class="icon-button" aria-label="清空搜索" @click="query = ''"><Icon name="close" :size="15"/></button></div>
          <p v-if="request.kind === 'search' && searchRefreshing" class="muted" role="status">正在更新搜索结果…</p>
          <p v-if="request.kind === 'search' && searchError" role="alert">{{ searchError }} <button class="button" @click="emit('retry-search')">重新加载搜索结果</button></p>
          <div v-if="stream" class="workstream-intro"><h3>{{ stream.name }}</h3><p>{{ stream.description }}</p><span class="muted">{{ stream.owner }} · {{ stream.start }} — {{ stream.end }}</span></div>
          <template v-if="['tasks','workstream','search','attention'].includes(request.kind)"><div v-if="request.kind !== 'search' || query" class="result-heading"><h4>任务</h4><span>{{ tasks.length }} 项</span></div><component :is="request.kind === 'search' ? 'a' : 'article'" v-for="t in tasks" :key="t.id" class="detail-list-card task-detail-card" :href="request.kind === 'search' ? `/projects/${encodeURIComponent(data.project.id)}/tasks/${encodeURIComponent(t.id)}` : undefined" :data-search-task="request.kind === 'search' ? t.id : undefined" :aria-label="request.kind === 'search' ? `查看任务详情：${t.title}` : undefined" :aria-disabled="request.kind === 'search' && searchBusy ? true : undefined" @click="request.kind === 'search' && openTask($event, t.id)"><div class="detail-card-top"><span class="task-reference">{{ t.id }}</span><span class="task-status" :class="t.status">{{ status(t.status) }}</span></div><h3>{{ t.title }}</h3><div class="detail-card-meta"><span><span class="tiny-avatar">{{ t.owner.slice(0,1) }}</span>{{ t.owner }}</span><span :class="{ 'red-text': t.status !== 'done' && !!t.due && t.due < data.project.asOf }"><Icon name="calendar" :size="13"/>{{ t.due || '待排期' }}<span v-if="t.status !== 'done' && !!t.due && t.due < data.project.asOf"> · 已逾期</span></span></div><div class="task-progress-line"><span><i :style="{ width:`${t.progress}%` }"></i></span><b>{{ t.progress }}%</b></div><p v-if="t.blocked" class="blocked-note"><Icon name="info" :size="14"/>存在依赖阻塞，需跟进前置事项。</p></component></template>
          <template v-if="canViewRisks && ['risks','search','attention'].includes(request.kind)"><div v-if="request.kind !== 'search' || query" class="result-heading"><h4>风险</h4><span>{{ risks.length }} 项</span></div><article v-for="r in risks" :key="r.id" class="detail-list-card"><div class="detail-card-top"><span class="risk-level" :class="r.level">{{ ({low:'低风险',medium:'中风险',high:'高风险',critical:'严重风险'} as Record<string,string>)[r.level || ''] || '待评估' }}</span><span class="muted">{{ ({identified:'待评估',assessed:'已评估',mitigating:'应对中',monitoring:'监控中',pending_close:'待关闭复核',closed:'已关闭'} as Record<string,string>)[r.status || ''] || '待评估' }}</span></div><h3>{{ r.title }}</h3><p>{{ r.description }}</p><div class="detail-card-meta"><span>责任人 {{ r.owner }}</span><span>处理期限 {{ r.due }}</span></div><small class="muted">关联 {{ r.taskIds.length }} 项任务</small><p v-if="r.reviewOverdue" class="red-text">复查已逾期 · {{ r.reviewDate }}</p><RouterLink class="button" :to="{name:'risk-detail',params:{riskId:r.id}}" @click="close">打开风险详情</RouterLink></article></template>
          <template v-if="['milestones','attention'].includes(request.kind)"><div class="result-heading"><h4>里程碑交付待处理</h4><span>{{ milestones.length }} 项</span></div><article v-for="m in milestones" :key="m.id" class="detail-list-card milestone-detail-card"><div class="detail-card-top"><span class="task-status" :class="m.milestoneState">{{ milestoneSummaryLabel(m) }}</span><span class="muted">{{ m.date || '待排期' }}</span></div><h3>{{ m.title }}</h3><p>{{ m.description }}</p><p v-if="milestoneAttention(m)" class="muted">{{ milestoneAttention(m)!.subtitle }}</p><div class="detail-card-meta"><span>{{ data.workstreams.find(w => w.id === m.workstreamId)?.name }}</span><Icon name="flag" :size="16"/></div><RouterLink class="button" :to="{name:'plan',params:{projectId:data.project.id},query:{view:'milestones',milestone:m.id}}" @click="close">打开里程碑详情</RouterLink></article><p v-if="!milestones.length" class="muted">当前没有需要验收、复核或补充历史凭证的里程碑。</p></template>
          <div v-if="request.kind === 'search' && (!query.trim() || (!tasks.length && !risks.length))" class="search-empty"><Icon name="search" :size="35"/><h3>{{ query.trim() ? '没有找到相关内容' : '快速找到需要关注的事情' }}</h3><p>{{ query.trim() ? '试试其他任务名称或负责人。' : (canViewRisks ? '搜索当前项目中的任务与风险。' : '搜索当前项目中的任务与负责人。') }}</p></div>
        </template>
      </div>
      <footer class="drawer-footer"><span><Icon name="info" :size="14"/>{{ data.project.isDemo ? 'DEMO · 示例项目' : data.project.name }}</span><button class="button primary" @click="close">{{ request.kind === 'search' ? '关闭搜索' : '返回总览' }}</button></footer>
    </div>
  </dialog>
</template>

<style scoped>
a.task-detail-card{display:block;color:inherit;text-decoration:none;cursor:pointer;transition:background-color .15s,border-color .15s}a.task-detail-card:hover{background:var(--primary-soft);border-color:var(--primary)}a.task-detail-card:focus-visible{outline:2px solid var(--primary);outline-offset:2px}a.task-detail-card:active{background:var(--primary-soft)}a.task-detail-card[aria-disabled="true"]{cursor:progress}a.task-detail-card h3{overflow-wrap:anywhere}
.task-status.legacy_achieved,.task-status.needs_review{color:var(--orange);background:var(--orange-soft)}.task-status.submitted{color:var(--primary);background:var(--primary-soft)}.risk-level.critical{background:var(--red-soft);color:var(--red);font-weight:700}.risk-level.low{background:var(--green-soft);color:var(--green)}.detail-list-card>.button{margin-top:12px;min-height:44px}
</style>
