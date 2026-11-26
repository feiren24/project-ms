<script lang="ts">
import { useProjectView, currentProjectId } from '../../stores/project-scope';
const defaultView = () => ({ display:'ledger', actor:'zhou', query:'', stream:'', level:'', state:'active', scope:'all', due:'', probability:0, impact:0, alertState:'active', alertId:'', scroll:0 });
</script>
<script setup lang="ts">
import { projectRoleLabels, isProjectManager } from '../../../../shared/src/permissions';

import { useAuthStore } from '../../stores/auth';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router';
import type { ManagedRisk, RiskAlert, RiskWorkspace } from '../../../../shared/src/risks';
import { evaluateRisks, fetchRisks } from '../../api/risks';
import { PlanningError } from '../../api/planning';
import RiskDrawer from './RiskDrawer.vue';
import AlertDrawer from './AlertDrawer.vue';
import { levels, states, riskLevel, levelFor, dateTime } from './labels';
import './risk-page.css';
const view = useProjectView('risks', defaultView);
const pageProjectId = currentProjectId();
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const auth = useAuthStore();
const isLegacy = computed(() => Boolean(auth.session?.legacyDemo));
watch(() => auth.actorForProject(pageProjectId), id => { if (!isLegacy.value) view.actor = id; }, { immediate: true });
const emit = defineEmits<{ 'overview-changed': []; notify: [message:string] }>();
const route = useRoute(), router = useRouter(), drawer = ref<InstanceType<typeof RiskDrawer>>(), alertDrawer = ref<InstanceType<typeof AlertDrawer>>();
const workspace = ref<RiskWorkspace|null>(null), loading = ref(false), evaluating = ref(false), error = ref(''), creating = ref(false), sourceAlert = ref<RiskAlert|null>(null);
let navigationHandled = false, refreshKey = '', refreshNeedsRead = false;
async function navigate(location:Parameters<typeof router.push>[0], replace=false){navigationHandled=true;try{await(replace?router.replace(location):router.push(location));}finally{navigationHandled=false;}}
const protect = ()=>drawer.value?.confirmNavigation() ?? alertDrawer.value?.confirmNavigation() ?? true;
onBeforeRouteLeave(()=>navigationHandled ? true : protect());
onBeforeRouteUpdate((to,from)=>navigationHandled || (to.params.projectId===from.params.projectId && to.params.riskId===from.params.riskId) ? true : protect());
const actor = computed(()=>workspace.value?.actors.find(a=>a.id===view.actor));
const writable = computed(()=>isProjectManager(actor.value?.role));
const currentRisk = computed(()=>workspace.value?.risks.find(r=>r.id===route.params.riskId)||null);
const currentAlert = computed(()=>!creating.value && !currentRisk.value ? workspace.value?.alerts.find(a=>a.id===view.alertId)||null : null);
const streamName = (id:string)=>workspace.value?.workstreams.find(s=>s.id===id)?.name || '项目整体';
const isLate = (r:ManagedRisk)=>r.status!=='closed' && r.due<workspace.value!.today;
const reviewLate = (r:ManagedRisk)=>r.status!=='closed' && !!r.reviewDate && r.reviewDate<workspace.value!.today;
const scopeRisks = computed(()=>(workspace.value?.risks||[]).filter(r=>(view.scope!=='mine'||r.ownerId===view.actor)&&(!view.query.trim()||`${r.title} ${r.owner} ${r.description}`.toLowerCase().includes(view.query.trim().toLowerCase()))&&(!view.stream||r.workstreamId===view.stream)&&(view.state==='all'||(view.state==='active'?r.status!=='closed':r.status===view.state))&&(!view.level||(view.level==='unscored'?r.score===null:view.level==='urgent'?['high','critical'].includes(r.level||r.legacyLevel||''):(r.level||r.legacyLevel)===view.level))&&(!view.due||(view.due==='late'?isLate(r):view.due==='review'?reviewLate(r):r.due===workspace.value?.today))));
const filteredRisks = computed(()=>scopeRisks.value.filter(r=>(!view.probability||r.probability===view.probability)&&(!view.impact||r.impact===view.impact)).slice().sort((a,b)=>Number(reviewLate(b))-Number(reviewLate(a))||a.due.localeCompare(b.due)));
const filteredAlerts = computed(()=>(workspace.value?.alerts||[]).filter(a=>(!view.stream||a.workstreamId===view.stream)&&(!view.query.trim()||`${a.title} ${a.evidence}`.toLowerCase().includes(view.query.trim().toLowerCase()))&&(view.alertState==='all'||(view.alertState==='active'?a.status!=='resolved':a.status===view.alertState))));
const cells = computed(()=>[5,4,3,2,1].flatMap(probability=>[1,2,3,4,5].map(impact=>({probability,impact,level:levelFor(probability*impact),count:scopeRisks.value.filter(r=>r.score!==null&&r.probability===probability&&r.impact===impact).length}))));
const unscored = computed(()=>scopeRisks.value.filter(r=>r.score===null));
function reset(){view.query='';view.stream='';view.level='';view.state='active';view.scope='all';view.due='';view.probability=0;view.impact=0;view.alertState='active';}
async function load(){if(disposed)return;loading.value=true;error.value='';try{const result=await fetchRisks(pageProjectId);if(disposed)return;workspace.value=result;if(!workspace.value.actors.some(a=>a.id===view.actor))view.actor=isLegacy.value ? workspace.value.actors[0]?.id||'' : '';}catch(e){if(disposed)return;error.value=e instanceof Error?e.message:'读取失败，请重试。';}finally{if(!disposed)loading.value=false;}}
async function recoverRefreshAccess() {
  refreshNeedsRead = true;
  refreshKey = '';
  try {
    const result = await fetchRisks(pageProjectId);
    if (disposed) return; workspace.value = result;
    refreshNeedsRead = false;
    error.value = '已重新读取最新记录与本机操作凭证，筛选已保留。请点击“刷新风险”重新评估。';
  } catch (e) {
    if (disposed) return;
    error.value = `本机操作凭证需要更新，暂未完成重新读取。${e instanceof Error ? e.message : '请重试恢复连接。'}`;
  }
}
async function refresh() {
  if (evaluating.value || loading.value) return;
  if (!writable.value) { await load(); return; }
  evaluating.value = true; error.value = '';
  try {
    // A rejected write is never replayed automatically after obtaining a new token.
    if (refreshNeedsRead) { await recoverRefreshAccess(); return; }
    if (!refreshKey) refreshKey = crypto.randomUUID();
    const result = await evaluateRisks(workspace.value!, view.actor, refreshKey);
    if (disposed) return; workspace.value = result;
    refreshKey = '';
    emit('overview-changed');
    emit('notify', '已按当前日重新评估自动预警，人工风险状态保持。');
  } catch (e) {
    if (disposed) return;
    if (e instanceof PlanningError && (e.status === 403 || e.code === 'PREVIEW_TOKEN_REQUIRED')) await recoverRefreshAccess();
    else error.value = e instanceof Error ? e.message : '评估失败，请重试。';
  } finally { if (!disposed) evaluating.value = false; }
}
async function open(r:ManagedRisk){view.alertId='';sourceAlert.value=null;creating.value=false;await navigate({name:'risk-detail',params:{riskId:r.id}});}
async function closeRisk(){creating.value=false;sourceAlert.value=null;if(route.params.riskId)await navigate({name:'risks'});}
async function saved(message:string,id?:string){creating.value=false;sourceAlert.value=null;await navigate({name:'risks'},true);if(disposed)return;await load();if(disposed)return;emit('overview-changed');emit('notify',message);if(id)await navigate({name:'risk-detail',params:{riskId:id}},true);}
function create(){sourceAlert.value=null;view.alertId='';creating.value=true;}
async function showAlert(id:string){await closeRisk();if(disposed)return;view.display='alerts';view.alertId=id;}
async function closeAlert(){ view.alertId=''; if(route.query.alertId) { const {alertId:_id,...query}=route.query; await router.replace({path:route.path,query}); } }
function convert(){sourceAlert.value=currentAlert.value;view.alertId='';creating.value=true;}
async function alertSaved(message:string){await closeAlert();if(disposed)return;await load();if(disposed)return;emit('overview-changed');emit('notify',message);}
function openTask(id:string){const riskId=currentRisk.value?.id;view.scroll=scrollContainer()?.scrollTop||0;navigate({name:'task-detail',params:{taskId:id},query:{from:'risks',actor:view.actor,...(riskId?{riskId}:{})}});}
function selectCell(probability:number,impact:number){view.probability=probability;view.impact=impact;nextTick(()=>document.getElementById('matrix-results')?.scrollIntoView({block:'nearest',behavior:'smooth'}));}
const scrollContainer=()=>document.querySelector<HTMLElement>('.main-content')||document.scrollingElement;
onMounted(async()=>{if(route.query.level==='urgent')view.level='urgent';await load();if(disposed)return;await nextTick();if(disposed)return;scrollContainer()?.scrollTo({top:view.scroll});});
watch(() => route.query.alertId, id => { if (typeof id === 'string') { view.display = 'alerts'; view.alertId = id; } }, { immediate: true });
onBeforeUnmount(()=>{view.scroll=scrollContainer()?.scrollTop||0;});
defineExpose({ refreshForCollaboration: async () => { await load(); return !disposed && !error.value; } });
</script>
<template>
<section class="risk-page" aria-labelledby="risk-page-title">
 <header class="risk-page-header"><div><span class="eyebrow">RISKS & EARLY WARNINGS</span><h1 id="risk-page-title">风险中心<span class="risk-title-dot"></span></h1><p>把风险看清楚，让应对有责任、关闭有依据。</p></div><div class="risk-header-actions"><button class="button" :disabled="loading||evaluating||!workspace" @click="refresh">{{ evaluating?'正在评估…':'刷新风险' }}</button><button class="button primary" :disabled="!writable||!workspace" @click="create">＋ 登记风险</button></div></header>
 <div v-if="workspace?.project.isDemo" class="risk-demo-note"><span class="demo-label">DEMO</span><p>本机示例项目 · 风险与应对任务持久保存。<span>{{ isLegacy ? '角色切换仅供隔离测试体验。' : `当前登录：${auth.user?.name || ''}，权限由项目角色决定。` }}</span></p><label v-if="isLegacy">体验身份<select v-model="view.actor" aria-label="风险体验身份" :disabled="creating||!!currentRisk||!!currentAlert"><option v-for="p in workspace?.actors||[]" :key="p.id" :value="p.id">{{ p.name }} · {{ projectRoleLabels[p.role] }}</option></select></label></div>
 <p v-if="loading&&!workspace" class="risk-empty" role="status">正在读取风险与预警…</p><div v-if="error" class="risk-error" role="alert">{{ error }}<button class="button" :disabled="loading||evaluating" @click="workspace?refresh():load()">重试</button></div>
 <template v-if="workspace">
  <div class="risk-summary"><article><span>未关闭风险</span><strong>{{ workspace.risks.filter(r=>r.status!=='closed').length }}</strong><small>台账由人工评估与复核</small></article><article><span>高 / 严重风险</span><strong class="orange-text">{{ workspace.risks.filter(r=>r.status!=='closed'&&['high','critical'].includes(r.level||r.legacyLevel||'')).length }}</strong><small>{{ workspace.risks.some(r => r.legacyLevel && r.score === null) ? '含历史示例等级，待人工评分' : '按人工评分统计' }}</small></article><article><span>复查逾期</span><strong>{{ workspace.risks.filter(reviewLate).length }}</strong><small>按当前日 {{ workspace.today }}</small></article><article><span>待处理预警</span><strong>{{ workspace.alerts.filter(a=>a.status==='open').length }}</strong><small>未知数据单独说明</small></article></div>
  <div class="risk-view-bar"><nav aria-label="风险视图"><button v-for="tab in [{id:'ledger',name:'风险台账'},{id:'alerts',name:'自动预警'},{id:'matrix',name:'风险矩阵'}]" :key="tab.id" :aria-pressed="view.display===tab.id" :class="{active:view.display===tab.id}" @click="view.display=tab.id">{{ tab.name }}</button></nav><span>风险记录 V{{ workspace.version }}</span></div>
  <div class="risk-workspace">
   <div class="risk-filters"><input v-model="view.query" aria-label="搜索风险与预警" placeholder="搜索名称、责任人或证据"/><select v-model="view.stream" aria-label="风险工作分组筛选"><option value="">全部工作分组</option><option v-for="s in workspace.workstreams" :key="s.id" :value="s.id">{{ s.name }}</option></select><template v-if="view.display!=='alerts'"><select v-model="view.level" aria-label="风险等级筛选"><option value="">全部等级</option><option value="urgent">高 / 严重</option><option v-for="(label,key) in levels" :key="key" :value="key">{{ label }}风险</option><option value="unscored">待人工评分</option></select><select v-model="view.state" aria-label="风险状态筛选"><option value="active">未关闭风险</option><option value="all">全部状态</option><option v-for="(label,key) in states" :key="key" :value="key">{{ label }}</option></select><select v-model="view.due" aria-label="风险处理期限筛选"><option value="">全部期限</option><option value="late">处理已逾期</option><option value="today">今天到期</option><option value="review">复查逾期</option></select><select v-model="view.scope" aria-label="风险责任范围"><option value="all">全部责任</option><option value="mine">我的责任</option></select></template><select v-else v-model="view.alertState" aria-label="预警状态筛选"><option value="active">待处理与暂缓</option><option value="all">全部预警</option><option value="open">待处理</option><option value="snoozed">已暂缓</option><option value="resolved">已恢复</option></select><button class="risk-link" @click="reset">重置筛选</button></div>
   <template v-if="view.display==='ledger'"><div class="risk-result-bar"><p>共 <b>{{ filteredRisks.length }}</b> 项风险<span v-if="view.probability"> · 概率 {{ view.probability }} / 影响 {{ view.impact }}</span></p><button v-if="view.probability" class="risk-link" @click="view.probability=0;view.impact=0">清除矩阵筛选</button></div><div class="risk-ledger"><article v-for="r in filteredRisks" :key="r.id" data-testid="risk-row" class="risk-row"><button class="risk-row-main" @click="open(r)"><span class="risk-row-meta">{{ r.id }} · {{ streamName(r.workstreamId) }}<span v-if="r.sourceAlertId"> · 来自自动预警</span></span><strong>{{ r.title }}</strong><span class="risk-row-description">{{ r.description || '待补充风险说明与应对方案' }}</span></button><div class="risk-row-status"><span class="risk-level" :class="`risk-level-${r.level||r.legacyLevel}`">{{ riskLevel(r) }}</span><span>{{ states[r.status] }}{{ r.occurred?' · 已发生':'' }}<strong v-if="r.needsHandover"> · 需要责任移交</strong></span></div><div class="risk-row-owner"><span>{{ r.owner }}</span><span :class="{'orange-text':isLate(r)}">{{ r.due }}{{ isLate(r)?' · 处理逾期':'' }}</span><small v-if="reviewLate(r)" class="orange-text">{{ r.reviewDate }} · 复查逾期</small></div><button class="risk-open" :aria-label="`查看风险 ${r.title}`" @click="open(r)">查看 ↗</button></article></div><div v-if="!filteredRisks.length" class="risk-empty"><h2>当前筛选下没有风险</h2><p>可调整筛选查看台账，或登记新的风险。</p><button class="button" @click="reset">查看全部未关闭风险</button></div></template>
   <template v-else-if="view.display==='alerts'"><div class="risk-rule-note"><h2>自动规则检查</h2><p>业务当前日 {{ workspace.today }}（Asia/Shanghai），项目{{ workspace.project.isDemo ? '示例快照日' : '统计基准日' }} {{ workspace.project.asOf }}。最近评估：{{ workspace.lastEvaluatedAt ? dateTime(workspace.lastEvaluatedAt) : '尚未评估' }}。</p><p>预警不会自动推导人工评分；暂缓到期重新检查，预警恢复也不会自动关闭台账。</p></div><div class="risk-rules"><article v-for="rule in workspace.rules" :key="rule.key"><div><h3>{{ rule.name }}</h3><span :class="{'orange-text':rule.status!=='evaluated'}">{{ {evaluated:'已检查',partial:'部分无法判断',unknown:'无法判断'}[rule.status] }} · {{ rule.triggered }} 项</span></div><p>{{ rule.message }}</p></article></div><p v-for="warning in workspace.warnings" :key="warning" class="risk-warning" role="status">{{ warning }}</p><div class="risk-result-bar"><p>当前筛选 <b>{{ filteredAlerts.length }}</b> 条预警</p></div><div class="risk-alerts"><article v-for="a in filteredAlerts" :key="a.id" data-testid="alert-row"><button @click="view.alertId=a.id"><span class="risk-row-meta">{{ streamName(a.workstreamId) }} · {{ {open:'待处理',snoozed:'已暂缓',resolved:'已恢复'}[a.status] }}</span><strong>{{ a.title }}</strong><p>{{ a.evidence }}</p><span class="risk-row-meta">{{ a.linkedRiskId?'已关联风险 · ':'' }}{{ a.status==='snoozed'?'暂缓至 '+a.snoozedUntil:'查看证据与处理' }} ↗</span></button></article></div><div v-if="!filteredAlerts.length" class="risk-empty"><h2>当前筛选下没有预警</h2><p>这不代表所有规则都已通过，请同时检查上方无法判断的数据。</p><button class="button" @click="reset">重置筛选</button></div></template>
   <template v-else><div class="risk-rule-note"><h2>概率 × 影响 · 5 × 5 风险矩阵</h2><p>点击格子查看对应台账。颜色表示评分等级，数字表示人工评分风险数量。</p><p>低 1–4 · 中 5–9 · 高 10–16 · 严重 17–25；未评分风险单列。</p></div><div class="risk-matrix-wrap"><span class="risk-axis-y">发生概率：高 → 低</span><div class="risk-matrix" aria-label="风险概率影响矩阵"><button v-for="cell in cells" :key="`${cell.probability}-${cell.impact}`" data-testid="risk-matrix-cell" :class="[`risk-level-${cell.level}`,{selected:view.probability===cell.probability&&view.impact===cell.impact}]" :aria-pressed="view.probability===cell.probability&&view.impact===cell.impact" :aria-label="`概率 ${cell.probability}，影响 ${cell.impact}，${levels[cell.level]}风险，${cell.count} 项`" @click="selectCell(cell.probability,cell.impact)"><strong>{{ cell.count }}</strong><small>{{ cell.probability }} × {{ cell.impact }}</small></button></div><span class="risk-axis-x">影响程度：1 很小 → 5 重大</span></div><section id="matrix-results" class="risk-matrix-results"><div class="risk-result-bar"><h3>{{ view.probability ? `概率 ${view.probability} × 影响 ${view.impact}` : '全部已评分风险' }}</h3><button v-if="view.probability" class="risk-link" @click="view.probability=0;view.impact=0">清除格子筛选</button></div><button v-for="r in filteredRisks.filter(r=>r.score!==null)" :key="r.id" class="risk-matrix-risk" @click="open(r)"><strong>{{ r.title }}</strong><span>{{ r.owner }} · {{ riskLevel(r) }} · {{ r.score }} 分 ↗</span></button><p v-if="!filteredRisks.some(r=>r.score!==null)" class="risk-inline-empty">当前格子或筛选中暂无已评分风险，可选择其他格子。</p></section><section class="risk-matrix-results"><h3>待人工评分 · {{ unscored.length }}</h3><p class="risk-inline-empty">以下风险不占矩阵格子；概率与影响须由人工评估。</p><button v-for="r in unscored" :key="r.id" class="risk-matrix-risk" @click="open(r)"><strong>{{ r.title }}</strong><span>{{ r.owner }} · {{ riskLevel(r) }} ↗</span></button><p v-if="!unscored.length" class="risk-inline-empty">当前筛选下所有风险均已有人工评分。</p></section></template>
  </div>
  <footer class="risk-page-footer"><span>变更保留记录 · 协作提醒通过站内通知查看</span><span>任务完成有证据，风险关闭有复核。</span></footer>
  <RiskDrawer v-if="creating||currentRisk" ref="drawer" :key="creating?'new':currentRisk!.id" :workspace="workspace" :risk="creating?null:currentRisk" :actor-id="view.actor" :source-alert="sourceAlert" :initial-workstream-id="view.stream || undefined" @close="closeRisk" @saved="saved" @reload="load" @task="openTask" @alert="showAlert"/>
  <AlertDrawer v-if="currentAlert" ref="alertDrawer" :key="currentAlert.id" :workspace="workspace" :alert="currentAlert" :actor-id="view.actor" @close="closeAlert" @reload="load" @saved="alertSaved" @convert="convert" @risk="id=>{const r=workspace?.risks.find(r=>r.id===id);if(r)open(r)}" @task="openTask"/>
  <div v-if="route.params.riskId&&!currentRisk&&!loading" class="risk-error" role="alert">未找到这个风险，请返回台账重新选择。<button class="button" @click="closeRisk">返回风险台账</button></div>
 </template>
</section>
</template>
