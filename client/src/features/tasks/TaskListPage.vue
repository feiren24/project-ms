<script lang="ts">
import { useProjectView, currentProjectId } from '../../stores/project-scope';
import {defaultTaskView as defaultView} from './task-view';
</script>
<script setup lang="ts">
import { projectRoleLabels, isProjectManager, canWriteProject } from '../../../../shared/src/permissions';

import { useAuthStore } from '../../stores/auth';
import { computed, inject, nextTick, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter, useRoute, onBeforeRouteLeave, onBeforeRouteUpdate } from 'vue-router';
import Icon from '../../components/Icon.vue';
import TaskDrawer from './TaskDrawer.vue';
import TaskDateFilterDialog from './TaskDateFilterDialog.vue';
import { taskDateLabels, type TaskDateFilter } from '../../../../shared/src/task-dates';
import TaskRecycleDialog from './TaskRecycleDialog.vue';
import './task-recycle.css';
import { searchReturnKey } from '../../stores/search-navigation';
import { batchTasks, fetchTaskPage, fetchTaskDetail, fetchTaskOptions } from '../../api/tasks';
import { PlanningError } from '../../api/planning';
import type { ManagedTask, TaskAction, TaskWorkspace, TaskPage } from '../../../../shared/src/tasks';
import './task-page.css';
import './task-date-filter.css';
const view = useProjectView('tasks', defaultView);
const pageProjectId = currentProjectId();
const dateOpen = ref(false);
const hasDateFilter = computed(() => !!(view.dateFrom && view.dateTo));
const dateSummary = computed(() => `${taskDateLabels[view.dateMode]}：${view.dateFrom} 至 ${view.dateTo}`);
const selectedStateLabel = computed(() => ({ active:'未完成', all:'全部状态', todo:'待办', in_progress:'进行中', submitted:'待验收', done:'已完成', cancelled:'已取消' }[view.state]));
function clearDates() { view.dateMode = 'overlap'; view.dateFrom = ''; view.dateTo = ''; dateOpen.value = false; }
function applyDates(value: TaskDateFilter) {
  const unchanged = view.dateMode === value.dateMode && view.dateFrom === value.dateFrom && view.dateTo === value.dateTo;
  Object.assign(view, value); dateOpen.value = false;
  if (unchanged) { selected.value = []; view.page = 1; boardPages.value = {}; void load(); }
}

let disposed = false;
onBeforeUnmount(() => { disposed = true; });
const auth = useAuthStore();
const isLegacy = computed(() => Boolean(auth.session?.legacyDemo));
watch(() => auth.actorForProject(pageProjectId), id => { if (!isLegacy.value) view.actor = id; }, { immediate: true });
const emit = defineEmits<{ 'overview-changed': []; notify: [message:string] }>();
const router = useRouter(), route = useRoute();
const searchReturn = inject(searchReturnKey, undefined);
const fromSearch = computed(() => Boolean(searchReturn?.active.value));
const drawerRef = ref<InstanceType<typeof TaskDrawer>>();
const taskTrail = ref<Array<{id: string; title: string}>>([]);
const deletingTask = ref<ManagedTask>(), recycleDialog = ref<InstanceType<typeof TaskRecycleDialog>>(), deletedDetail = ref(false);
async function deleted() { deletingTask.value=undefined; editor.value=null; emit('overview-changed'); emit('notify','任务已移入回收站，删除原因已保存。'); closeDrawer(); await load(); }
let navigationHandled = false;
async function navigateHandled(location: Parameters<typeof router.push>[0], replace = false) { navigationHandled = true; try { await (replace ? router.replace(location) : router.push(location)); } finally { navigationHandled = false; } }
function protectNavigation() { if (recycleDialog.value && !recycleDialog.value.confirmNavigation()) return false; if (bulkBusy.value) return false; if (bulkOpen.value && bulkReason.value && !window.confirm('批量修改尚未保存，离开将丢弃填写内容。是否离开？')) return false; return drawerRef.value?.confirmNavigation() ?? true; }
onBeforeRouteLeave(() => navigationHandled ? true : protectNavigation());
onBeforeRouteUpdate((to, from) => navigationHandled || (to.params.projectId === from.params.projectId && to.params.taskId === from.params.taskId) ? true : protectNavigation());
const editor = ref<TaskWorkspace | null>(null), pageData = ref<TaskPage | null>(null);
const boardPages = ref<Record<string,number>>({}), boardLoading = ref(''), editorLoading = ref(false);
let loadSequence = 0, editorSequence = 0, filterTimer: ReturnType<typeof setTimeout> | undefined, mounted = false;
const workspace = ref<TaskWorkspace | null>(null), loading = ref(false), error = ref('');
const selected = ref<string[]>([]), creating = ref(false), initialAction = ref<TaskAction>();
const bulkOpen = ref(false), bulkDialog = ref<HTMLDialogElement>(), bulkKind = ref<'owner'|'priority'>('priority'), bulkValue = ref('P1'), bulkReason = ref(''), bulkBusy = ref(false), bulkError = ref(''), bulkStage = ref<'edit'|'confirm'>('edit');
const dragged = ref<string|null>(null), dropColumn = ref('');
let bulkKey = '', bulkPayload = '';
const actor = computed(() => workspace.value?.actors.find(a => a.id === view.actor));
const manager = computed(() => isProjectManager(actor.value?.role));
const columns = [{ id:'todo', name:'待办', note:'准备好下一步', color:'slate' }, { id:'in_progress', name:'进行中', note:'把计划推进到结果', color:'blue' }, { id:'submitted', name:'待验收', note:'仅关键交付进入此列', color:'orange' }, { id:'done', name:'已完成', note:'每一份交付都有记录', color:'green' }];
const currentTask = computed(() => editor.value?.tasks.find(t => t.id === route.params.taskId) || null);
const scopeTasks = computed(() => (workspace.value?.tasks || []).filter(t => view.scope === 'all' || (view.scope === 'mine' ? t.ownerId === view.actor : t.reviewerId === view.actor)));
const displayState = (t:ManagedTask) => t.status === 'cancelled' ? 'cancelled' : t.reviewStatus === 'submitted' ? 'submitted' : t.status;
const stateName = (t:ManagedTask) => ({ todo:'待办', in_progress:'进行中', submitted:'待验收', done:'已完成', cancelled:'已取消' }[displayState(t)]);
const late = (t:ManagedTask) => !!t.end && !!workspace.value && t.end < workspace.value.project.asOf && !['done','cancelled'].includes(t.status);
const isSummary = (task: ManagedTask) => task.taskKind === 'summary' || !!task.isContainer;
const executionScope = computed(() => scopeTasks.value.filter(t => !isSummary(t)));
const taskDepth = (task: ManagedTask) => {
  let depth = 1, node: ManagedTask | undefined = task;
  const seen = new Set([task.id]);
  while (node?.parentId && !seen.has(node.parentId)) { depth++; seen.add(node.parentId); node = workspace.value?.tasks.find(t => t.id === node!.parentId); }
  return depth;
};
const hierarchyLabel = (task: ManagedTask) => {
  const depth = taskDepth(task);
  return [depth > 2 ? `历史第${depth}级任务` : depth === 2 ? '二级任务' : '', isSummary(task) ? '汇总父任务' : '', task.originalWork ? '原有工作' : ''].filter(Boolean).join(' · ');
};
const parentTitle = (task: ManagedTask) => task.parentTitle || workspace.value?.tasks.find(t => t.id === task.parentId)?.title || '父任务记录缺失';
const filteredTasks = computed(() => workspace.value?.tasks ?? []);
const scopeCount = (key:string) => pageData.value?.scopeCounts[key as 'all'|'mine'|'review'] ?? 0;
const summaryCount = (key:'active'|'late'|'submitted'|'blocked') => pageData.value?.summary[key] ?? 0;
const boardCount = (key:string) => pageData.value?.boardCounts[key] ?? 0;
const extraFilters = computed(() => !!(view.query || view.stream || view.owner || view.priority || view.due || hasDateFilter.value || view.state !== 'active'));
const bulkCandidates = computed(() => filteredTasks.value.filter(t => !isSummary(t)));
const allSelected = computed(() => !!bulkCandidates.value.length && bulkCandidates.value.every(t => selected.value.includes(t.id)));
const bulkTasks = computed(() => workspace.value?.tasks.filter(t => !isSummary(t) && selected.value.includes(t.id)) || []);
const selectedVersions = ref<Array<{id:string;expectedVersion:number}>>([]);
const bulkPlanVersion = ref(0);
const shownColumns = computed(() => view.state === 'cancelled' ? [{ id:'cancelled',name:'已取消',note:'保留历史，可按需重新打开',color:'slate' }] : columns);
const streamName = (id:string) => workspace.value?.workstreams.find(s => s.id === id)?.name || id;
const canOperate = (task:ManagedTask) => !isSummary(task) && actor.value?.role !== 'viewer' && (manager.value || task.ownerId === view.actor);
function query(page = view.page, boardState = ''): Record<string,string> {
  return { page:String(page), pageSize:String(view.pageSize), scope:view.scope, actorId:view.actor, query:view.query, workstreamId:view.stream, ownerId:view.owner, state:view.state, priority:view.priority, due:view.due, sort:view.sort, ...(hasDateFilter.value ? {dateMode:view.dateMode,dateFrom:view.dateFrom,dateTo:view.dateTo} : {}), ...(boardState ? {boardState,pageSize:'50'} : {}) };
}
async function loadEditor() {
  deletedDetail.value=false;
  const sequence = ++editorSequence, id = route.params.taskId;
  if (typeof id !== 'string' && !creating.value) { editorLoading.value=false; editor.value=null; return; }
  editorLoading.value=true;
  try { const result = typeof id === 'string' ? await fetchTaskDetail(pageProjectId,id,view.actor) : await fetchTaskOptions(pageProjectId); if (!disposed && sequence===editorSequence) editor.value=result; }
  catch(e) { if (!disposed && sequence===editorSequence) { deletedDetail.value=e instanceof PlanningError && e.code==='TASK_DELETED'; if (deletedDetail.value || !editor.value?.tasks.some(t => t.id === id)) editor.value=null; error.value=e instanceof Error?e.message:'任务详情暂时无法读取，请重试。'; } }
  finally {if(sequence===editorSequence)editorLoading.value=false;}
}
async function startCreate() {
  if (!canWriteProject(actor.value?.role) || editorLoading.value) return;
  editorLoading.value=true;
  try { const result=await fetchTaskOptions(pageProjectId); if(disposed)return; editor.value=result; initialAction.value=undefined; creating.value=true; }
  catch(e) { error.value=e instanceof Error?e.message:'创建任务选项暂时无法读取，请重试。'; }
  finally {editorLoading.value=false;}
}
async function load() {
  if (disposed) return;
  const sequence=++loadSequence; loading.value=true; error.value=''; boardLoading.value='';
  try {
    const board = view.display==='board';
    const results = await Promise.all(board ? shownColumns.value.map(column => fetchTaskPage(pageProjectId,query(1,column.id))) : [fetchTaskPage(pageProjectId,query())]);
    if(disposed || sequence!==loadSequence)return;
    const result=results[0]!; pageData.value=board?{...result,total:Object.values(result.boardCounts).reduce((sum,n)=>sum+n,0)}:result; view.page=result.page;
    workspace.value={...result,tasks:results.flatMap(page=>page.tasks)};
    boardPages.value={}; selected.value=selected.value.filter(id=>workspace.value!.tasks.some(t=>t.id===id && !isSummary(t)));
  } catch(e) { if(!disposed && sequence===loadSequence)error.value=e instanceof Error?e.message:'任务暂时无法读取，请重试。'; }
  finally { if(!disposed && sequence===loadSequence)loading.value=false; }
}
async function loadMore(column:string) {
  if(boardLoading.value || !workspace.value)return; boardLoading.value=column;
  const sequence=loadSequence, page=(boardPages.value[column]??1)+1;
  try { const result=await fetchTaskPage(pageProjectId,query(page,column)); if(disposed || sequence!==loadSequence)return;
    const existing=new Set(workspace.value.tasks.map(task=>task.id));workspace.value.tasks.push(...result.tasks.filter(task=>!existing.has(task.id)));boardPages.value[column]=result.page;
  } catch(e) {if(!disposed && sequence===loadSequence)error.value=e instanceof Error?e.message:'加载失败，请重试。';} finally {if(sequence===loadSequence)boardLoading.value='';}
}
async function retryLoad() { await Promise.all([load(),loadEditor()]); }
function changePage(page:number) { selected.value=[];view.page=page;void load(); }
function reset() { clearDates(); view.query=''; view.stream=''; view.owner=''; view.state='active'; view.priority=''; view.due=''; }
function open(task:ManagedTask, action?:TaskAction) { taskTrail.value = []; creating.value = false; initialAction.value = action; navigateHandled({ name:'task-detail',params:{taskId:task.id},query:['analytics','risks'].includes(String(route.query.from)) ? route.query : {} }); }
function closeDrawer() { taskTrail.value = []; if (fromSearch.value) { navigationHandled = true; void searchReturn!.close().finally(() => { navigationHandled = false; }); return; } creating.value = false; editor.value=null; initialAction.value = undefined; if (route.params.taskId) navigateHandled(route.query.from === 'risks' ? {name:route.query.riskId ? 'risk-detail' : 'risks',params:route.query.riskId ? {riskId:String(route.query.riskId)} : {}} : {name:route.query.from === 'analytics' ? 'analytics' : 'tasks'}); }
async function saved(message:string, taskId?:string) {
  const retainedId = taskId || (typeof route.params.taskId === 'string' ? route.params.taskId : undefined);
  initialAction.value = undefined;
  if (retainedId && retainedId !== route.params.taskId) await navigateHandled({name:'task-detail',params:{taskId:retainedId},query:route.query},true);
  creating.value = false;
  await Promise.all([load(), loadEditor()]);
  if (!disposed) { emit('overview-changed'); emit('notify',message); }
}
async function planSaved() { await Promise.all([load(),loadEditor()]); if (!disposed) { emit('overview-changed'); emit('notify','计划与依赖已保存。'); } }
function openRelatedTask(id:string) { if (currentTask.value) taskTrail.value.push({id:currentTask.value.id,title:currentTask.value.title}); void navigateHandled({name:'task-detail',params:{taskId:id},query:route.query},fromSearch.value); }
function backTask() { const target = taskTrail.value.pop(); if (target) void navigateHandled({name:'task-detail',params:{taskId:target.id},query:route.query},fromSearch.value); }
function showPlan(taskId:string) { navigateHandled({name:'plan',query:{task:taskId,view:'gantt',taskTab:'plan'}}); }
function toggleSelected(id:string) { if (!manager.value || !workspace.value?.tasks.some(t => t.id === id && !isSummary(t))) return; selected.value = selected.value.includes(id) ? selected.value.filter(v=>v!==id) : [...selected.value,id]; }
function selectAll() { if (!manager.value) return; selected.value = allSelected.value ? [] : bulkCandidates.value.map(t=>t.id); }
async function showBulk() { if (!manager.value || !bulkTasks.value.length) return; bulkOpen.value=true; bulkReason.value=''; bulkError.value=''; bulkStage.value='edit'; selectedVersions.value=bulkTasks.value.map(t=>({id:t.id,expectedVersion:t.version})); bulkPlanVersion.value=workspace.value!.planVersion; await nextTick(); bulkDialog.value?.showModal(); }
async function applyBulk() {
  bulkBusy.value=true; bulkError.value='';
  const patch = bulkKind.value === 'owner' ? { ownerId:bulkValue.value } : { priority:bulkValue.value as 'P0'|'P1'|'P2' };
  const hash = JSON.stringify({items:selectedVersions.value,patch,reason:bulkReason.value,version:bulkPlanVersion.value});
  if (hash !== bulkPayload) { bulkPayload=hash; bulkKey=crypto.randomUUID(); }
  try { const result = await batchTasks({...workspace.value!,planVersion:bulkPlanVersion.value},view.actor,selectedVersions.value,patch,bulkReason.value,bulkKey); if (disposed) return; bulkDialog.value?.close(); selected.value=[]; await load(); if (disposed) return; emit('overview-changed'); emit('notify',`已更新 ${result.affectedCount} 项任务，记录已保存。`); }
  catch(e) { if (disposed) return; bulkError.value=e instanceof Error ? e.message : '批量操作失败，请重试。'; if(e instanceof PlanningError && [403,409].includes(e.status)) { await load(); if (disposed) return; bulkStage.value='edit'; } }
  finally { if (!disposed) bulkBusy.value=false; }
}
function reviewBulk() { if (!bulkTasks.value.length || !bulkValue.value || !bulkReason.value.trim()) return; selectedVersions.value=bulkTasks.value.map(t=>({id:t.id,expectedVersion:t.version})); bulkPlanVersion.value=workspace.value!.planVersion; bulkError.value=''; bulkStage.value='confirm'; }
function startDrag(event:DragEvent, task:ManagedTask) { if (!canOperate(task)) { event.preventDefault(); return; } dragged.value=task.id; event.dataTransfer?.setData('text/plain',task.id); if(event.dataTransfer) event.dataTransfer.effectAllowed='move'; }
function drop(target:string) {
  dropColumn.value=''; const task=workspace.value?.tasks.find(t=>t.id===dragged.value); dragged.value=null; if(!task || displayState(task)===target) return;
  let action:TaskAction|undefined;
  if(target==='in_progress' && task.status==='todo') action='start';
  else if(target==='in_progress' && ['done','cancelled'].includes(task.status)) action='reopen';
  else if(target==='submitted' && task.requiresReview && task.status==='in_progress') action='submit';
  else if(target==='done' && !task.requiresReview && task.status==='in_progress') action='complete';
  if(action) open(task,action); else emit('notify',task.requiresReview && target==='done' ? '关键交付需要提交独立验收；请在详情中提交成果。' : '此状态不能直接拖动转换，请打开任务查看可用操作。');
}
watch(() => [view.query,view.stream,view.owner,view.state,view.priority,view.due,view.dateMode,view.dateFrom,view.dateTo,view.scope,view.actor,view.sort,view.display,view.pageSize],()=>{selected.value=[];view.page=1;if(!mounted)return;loading.value=true;error.value='';loadSequence++;boardPages.value={};clearTimeout(filterTimer);filterTimer=setTimeout(()=>void load(),150);});
watch(() => route.params.taskId,()=>{if(mounted)void loadEditor();});
onBeforeUnmount(()=>{clearTimeout(filterTimer);loadSequence++;editorSequence++;});
watch(() => view.state, state => { if(state==='cancelled') view.boardColumn='cancelled'; else if(view.boardColumn==='cancelled') view.boardColumn='todo'; });
watch(() => view.actor,()=>{if (!isLegacy.value) return; emit('notify',`已切换为 ${actor.value?.name || ''} 的 DEMO 体验身份。`);});
function applyWorkstreamDrilldown(value: unknown) {
  if (typeof value !== 'string') return;
  clearDates();
  view.query = ''; view.stream = value; view.owner = ''; view.state = 'all'; view.priority = ''; view.due = ''; view.scope = 'all';
}
watch(() => route.query.workstreamId, applyWorkstreamDrilldown);
onMounted(async () => { applyWorkstreamDrilldown(route.query.workstreamId); const filter = route.query.filter; if (typeof filter === 'string' || ['analytics','risks'].includes(String(route.query.from))) clearDates(); if (filter === 'done') view.state='done'; else if(filter === 'overdue') {view.state='active';view.due='late';} else if(filter === 'pending') view.state='active'; mounted=true; await Promise.all([load(),loadEditor()]); if(disposed)return; if(isLegacy.value && route.query.from === 'risks' && workspace.value?.actors.some(a=>a.id===route.query.actor)) view.actor=String(route.query.actor); }); onBeforeUnmount(()=>bulkDialog.value?.close());
defineExpose({ refreshForCollaboration: async () => { await Promise.all([load(),loadEditor()]); return !disposed && !error.value; } });
</script>
<template>
  <section class="task-page" aria-labelledby="task-page-title">
    <header class="task-page-header"><div><span class="eyebrow">TASKS & COLLABORATION</span><h1 id="task-page-title">任务管理<span class="task-title-dot"></span></h1><p>把每一项计划，推进为看得见的交付。</p></div><div class="recycle-inline-actions"><button class="button" @click="router.push({name:'task-recycle'})">已删除任务</button><button class="button primary" :disabled="!canWriteProject(actor?.role) || !workspace" @click="startCreate"><span class="task-plus" aria-hidden="true">＋</span>新建任务</button></div></header>
    <div v-if="workspace?.project.isDemo" class="task-demo-note"><span class="demo-label">DEMO</span><p>本机示例协作 · 修改会同步到项目总览和完整计划。<span>{{ isLegacy ? '角色切换仅供隔离测试体验。' : `当前登录：${auth.user?.name || ''}，权限由项目角色决定。` }}</span></p><label v-if="isLegacy">体验身份<select v-model="view.actor" aria-label="任务体验身份" :disabled="creating || !!route.params.taskId || bulkOpen"><option v-for="person in workspace?.actors || []" :key="person.id" :value="person.id">{{ person.name }} · {{ projectRoleLabels[person.role] }}</option></select></label></div>
    <div v-if="!workspace && loading" class="task-empty" role="status">正在读取任务工作台…</div>
    <div v-if="error" class="task-page-error" role="alert">{{ error }}<button class="button" @click="retryLoad">重新加载任务</button></div>
    <div v-if="route.params.taskId && editorLoading" class="task-route-loading" role="status">正在读取任务详情…</div>
    <div v-if="route.params.taskId && !currentTask && !loading && !editorLoading" class="task-route-error" role="alert"><h2>{{ deletedDetail ? '任务已删除' : error ? '任务详情暂时无法加载' : '未找到这个任务' }}</h2><p>{{ error ? '可以重新加载任务，或返回之前的页面。' : '任务可能不存在或当前账号无权访问，请返回重新选择。' }}</p><button v-if="deletedDetail" class="button" @click="router.push({name:'task-recycle',query:{task:String(route.params.taskId)}})">查看删除记录</button><button class="button" @click="closeDrawer">{{ fromSearch ? '返回搜索结果' : '返回任务列表' }}</button></div>
    <template v-if="workspace">
      <div class="task-scope-bar"><nav aria-label="任务责任范围"><button v-for="item in [{id:'all',name:'全部任务'},{id:'mine',name:'我的任务'},{id:'review',name:'我来验收'}]" :key="item.id" :class="{active:view.scope===item.id}" :aria-pressed="view.scope===item.id" @click="view.scope=item.id">{{ item.name }}<span>{{ scopeCount(item.id) }}</span></button></nav><div class="task-view-switch" aria-label="任务视图"><button :class="{active:view.display==='list'}" :aria-pressed="view.display==='list'" @click="view.display='list'"><Icon name="task" :size="15"/>列表</button><button :class="{active:view.display==='board'}" :aria-pressed="view.display==='board'" @click="view.display='board'"><Icon name="grid" :size="15"/>看板</button></div></div>
      <div class="task-summary-line"><span>当前责任范围<span class="task-date-summary-note">总览与责任范围数量不随下方筛选变化</span></span><button @click="view.state='active';view.due=''">未完成 <b>{{ summaryCount('active') }}</b></button><i></i><button @click="view.state='active';view.due='late'">逾期 <b class="orange-text">{{ summaryCount('late') }}</b></button><i></i><button @click="view.state='submitted';view.due=''">待验收 <b>{{ summaryCount('submitted') }}</b></button><i></i><button @click="view.state='active';view.due='blocked'">阻塞 <b>{{ summaryCount('blocked') }}</b></button><span class="task-summary-snapshot">{{ workspace.project.isDemo ? '示例快照日' : '统计基准日' }} {{ workspace.project.asOf }}</span></div>
      <div class="task-workspace-panel">
        <div class="task-filter-row"><label class="task-search"><Icon name="search" :size="17"/><input v-model="view.query" placeholder="搜索任务名称、编号、负责人" aria-label="搜索任务"/><button v-if="view.query" aria-label="清空任务搜索" class="icon-button" @click="view.query=''"><Icon name="close" :size="14"/></button></label><select v-model="view.stream" aria-label="任务工作分组筛选"><option value="">全部工作分组</option><option v-for="s in workspace.workstreams" :key="s.id" :value="s.id">{{s.name}}{{s.active === false ? '（已停用）' : ''}}</option></select><select v-model="view.owner" aria-label="任务负责人筛选"><option value="">全部负责人</option><option v-for="person in workspace.actors" :key="person.id" :value="person.id">{{person.name}}</option></select><select v-model="view.state" aria-label="任务状态筛选"><option value="active">未完成任务</option><option value="all">全部状态</option><option value="todo">待办</option><option value="in_progress">进行中</option><option value="submitted">待验收</option><option value="done">已完成</option><option value="cancelled">已取消</option></select><button class="button task-date-trigger" :class="{'is-active':hasDateFilter}" aria-label="任务日期筛选" :aria-expanded="dateOpen" aria-haspopup="dialog" @click="dateOpen=true">{{ hasDateFilter ? dateSummary : '日期：不限' }} ▾</button><select v-model="view.priority" aria-label="任务优先级筛选"><option value="">全部优先级</option><option value="P0">P0 · 紧急</option><option value="P1">P1 · 高</option><option value="P2">P2 · 普通</option></select><select v-model="view.due" aria-label="任务期限筛选"><option value="">全部期限</option><option value="late">已逾期</option><option value="today">快照日到期</option><option value="unplanned">待排期</option><option value="blocked">存在阻塞</option></select></div>
        <div v-if="hasDateFilter" class="task-date-applied"><span class="task-date-chip"><span>{{ dateSummary }}</span><button class="icon-button" aria-label="移除日期筛选" @click="clearDates">×</button></span><span>状态：{{ selectedStateLabel }}</span><span>未排期任务不计入</span></div>
        <div class="task-result-bar"><p>共 <b>{{ loading ? '…' : error ? '—' : pageData?.total ?? 0 }}</b> 项<span v-if="view.state==='active'"> · 已隐藏完成与取消任务</span><button v-if="extraFilters" class="task-link" @click="reset">重置筛选</button></p><label>排序<select v-model="view.sort" aria-label="任务排序"><option value="due">截止日期</option><option value="priority">优先级</option><option value="wbs">任务编号</option><option value="plan">计划顺序</option><option value="updated">最近更新</option></select></label><button class="icon-button" aria-label="刷新任务" :disabled="loading" @click="load"><Icon name="refresh" :size="16"/></button></div>
        <p v-if="manager" id="task-bulk-scope-note" class="task-bulk-scope-note">批量修改仅选择执行任务；汇总任务只读，不参与批量修改。</p>
        <div v-if="loading" class="task-empty" role="status">正在按当前条件筛选任务…</div>
        <div v-else-if="error" class="task-empty">当前结果未更新，请使用上方“重新加载任务”重试。</div>
        <div v-else-if="!filteredTasks.length" class="task-empty"><Icon name="task" :size="36"/><h2>这里暂时没有任务</h2><p>{{ hasDateFilter ? (view.due==='unplanned' ? '日期范围与待排期条件不匹配。未排期任务缺少完整计划日期，请清除其中一个条件。' : `${dateSummary}，状态：${selectedStateLabel}。当前条件下没有匹配任务。`) : view.scope==='review' ? '分配给你的关键交付会出现在这里。也可以切换到全部任务。' : '当前筛选条件下没有匹配任务，可调整筛选或新建任务。' }}</p><div v-if="hasDateFilter" class="task-date-empty-actions"><button class="button" @click="dateOpen=true">修改日期</button><button class="button" @click="clearDates">清除日期</button><button v-if="view.due==='unplanned'" class="button" @click="view.due=''">清除待排期条件</button><button class="button" @click="reset">重置筛选</button></div><button v-else class="button" @click="reset(); view.scope='all'">查看未完成任务</button></div>
        <template v-else-if="view.display==='list'"><div class="task-table-wrapper"><table class="task-table"><caption class="task-sr-only">项目任务列表</caption><thead><tr><th class="task-select-cell"><input v-if="manager" type="checkbox" aria-label="选择全部筛选任务" :checked="allSelected" :disabled="!bulkCandidates.length" aria-describedby="task-bulk-scope-note" @change="selectAll"/></th><th>任务 / 所属工作分组</th><th>状态</th><th>负责人</th><th>截止日期</th><th>优先级</th><th>进度</th><th></th></tr></thead><tbody><tr v-for="task in filteredTasks" :key="task.id" :class="{'task-row-selected':selected.includes(task.id)}"><td class="task-select-cell"><input v-if="manager" type="checkbox" :aria-label="`选择任务 ${task.title}`" :checked="!isSummary(task) && selected.includes(task.id)" :disabled="isSummary(task)" :aria-describedby="isSummary(task) ? 'task-bulk-scope-note' : undefined" :title="isSummary(task) ? '汇总任务只读，不参与批量修改' : undefined" @change="toggleSelected(task.id)"/></td><td class="task-name-cell"><button @click="open(task)"><span class="task-row-id">{{ task.wbs }}<span v-if="task.requiresReview" class="task-key-label">关键交付</span><span v-if="hierarchyLabel(task)" class="task-key-label">{{ hierarchyLabel(task) }}</span></span><b>{{ task.title }}</b><span v-if="task.parentId" class="task-parent-context">父任务：{{ parentTitle(task) }}</span><span class="task-stream-label"><i :class="`dot-${workspace.workstreams.find(s=>s.id===task.workstreamId)?.color || 'blue'}`"></i>{{ streamName(task.workstreamId) }}<span v-if="task.blocked" class="task-blocked-label">· 阻塞</span><span v-if="task.reviewStatus==='needs_review'" class="task-blocked-label">· 需复核</span></span></button></td><td><span class="task-state-pill" :class="`task-state-${displayState(task)}`">{{ stateName(task) }}</span></td><td><span class="task-owner"><span>{{task.owner.slice(0,1)}}</span>{{task.owner}}</span></td><td><span class="task-date" :class="{'orange-text':late(task)}">{{task.end?.slice(5) || '待排期'}}<small v-if="late(task)">已逾期</small></span></td><td><span class="task-priority" :class="task.priority.toLowerCase()">{{task.priority}}</span></td><td><div class="task-progress"><span><i :style="{width:`${task.progress}%`}"></i></span><small>{{task.progress}}%</small></div></td><td><details v-if="task.canDelete" class="task-more"><summary :aria-label="`任务更多操作 ${task.title}`">···</summary><div class="task-more-menu"><button @click="deletingTask=task; ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">删除任务</button></div></details><button class="icon-button" :aria-label="`查看任务 ${task.title}`" @click="open(task)"><Icon name="chevron" :size="15"/></button></td></tr></tbody></table></div>
        <div class="task-mobile-cards"><article v-for="task in filteredTasks" :key="task.id"><div class="task-mobile-top"><input v-if="manager" type="checkbox" :aria-label="`选择任务 ${task.title}`" :checked="!isSummary(task) && selected.includes(task.id)" :disabled="isSummary(task)" :aria-describedby="isSummary(task) ? 'task-bulk-scope-note' : undefined" :title="isSummary(task) ? '汇总任务只读，不参与批量修改' : undefined" @change="toggleSelected(task.id)"/><span>{{task.wbs}} · {{streamName(task.workstreamId)}}</span><span class="task-state-pill" :class="`task-state-${displayState(task)}`">{{stateName(task)}}</span></div><button @click="open(task)"><h3>{{task.title}}</h3><div v-if="hierarchyLabel(task)" class="task-parent-context">{{ hierarchyLabel(task) }}<span v-if="task.parentId"> · {{ parentTitle(task) }}</span></div><p><span class="task-priority" :class="task.priority.toLowerCase()">{{task.priority}}</span><span v-if="task.requiresReview" class="task-key-label">关键交付</span><span v-if="task.blocked" class="task-blocked-label">阻塞</span><span class="task-mobile-progress">{{task.progress}}%</span></p><footer><span>{{task.owner}}</span><span :class="{'orange-text':late(task)}">{{task.end || '待排期'}}{{late(task)?' · 逾期':''}}</span></footer></button><details v-if="task.canDelete" class="task-more"><summary :aria-label="`任务更多操作 ${task.title}`">···</summary><div class="task-more-menu"><button @click="deletingTask=task; ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">删除任务</button></div></details></article></div></template>
        <template v-else><div class="task-mobile-board-tabs"><button v-for="column in shownColumns" :key="column.id" :class="{active:view.boardColumn===column.id}" @click="view.boardColumn=column.id">{{column.name}} {{boardCount(column.id)}}</button></div><div class="task-board"><section v-for="column in shownColumns" :key="column.id" class="task-board-column" :class="{'task-drop-active':dropColumn===column.id,'task-mobile-column-hidden':view.boardColumn!==column.id}" :aria-label="`${column.name}看板列`" @dragover.prevent="dropColumn=column.id" @dragleave.self="dropColumn=''" @drop.prevent="drop(column.id)"><header><i :class="`dot-${column.color}`"></i><h2>{{column.name}}</h2><span>{{boardCount(column.id)}}</span></header><p class="task-column-note">{{column.note}}</p><article v-for="task in filteredTasks.filter(t=>displayState(t)===column.id)" :key="task.id" class="task-board-card" :draggable="canOperate(task)" @dragstart="startDrag($event,task)" @dragend="dragged=null;dropColumn='' "><button @click="open(task)"><span class="task-card-top"><span>{{task.wbs}}</span><span class="task-priority" :class="task.priority.toLowerCase()">{{task.priority}}</span></span><h3>{{task.title}}</h3><p v-if="hierarchyLabel(task)" class="task-parent-context">{{ hierarchyLabel(task) }}<span v-if="task.parentId"> · {{ parentTitle(task) }}</span></p><p class="task-card-stream">{{streamName(task.workstreamId)}}</p><div class="task-card-badges"><span v-if="task.requiresReview" class="task-key-label">关键交付</span><span v-if="task.blocked" class="task-blocked-label">阻塞</span><span v-if="task.reviewStatus==='needs_review'" class="task-blocked-label">需复核</span></div><div class="task-progress"><span><i :style="{width:`${task.progress}%`}"></i></span><small>{{task.progress}}%</small></div><footer><span class="task-owner"><span>{{task.owner.slice(0,1)}}</span>{{task.owner}}</span><span :class="{'orange-text':late(task)}">{{task.end?.slice(5)||'待排期'}}{{late(task)?' · 逾期':''}}</span></footer></button><details v-if="task.canDelete" class="task-more"><summary :aria-label="`任务更多操作 ${task.title}`">···</summary><div class="task-more-menu"><button @click="deletingTask=task; ($event.currentTarget as HTMLElement).closest('details')?.removeAttribute('open')">删除任务</button></div></details></article><button v-if="filteredTasks.filter(t=>displayState(t)===column.id).length < boardCount(column.id)" class="button task-load-more" :disabled="!!boardLoading" @click="loadMore(column.id)">{{boardLoading===column.id?'正在加载…':'加载更多任务'}}</button><p v-if="!filteredTasks.some(t=>displayState(t)===column.id)" class="task-column-empty">当前筛选下暂无任务</p></section></div><p class="task-board-help">拖动任务会先打开确认界面 · 手机可点击任务进行操作 · 关键交付不能绕过验收</p></template>
      </div>
      <div v-if="bulkTasks.length" class="task-bulk-bar"><span>已选择 <b>{{bulkTasks.length}}</b> 项任务</span><button class="button" @click="showBulk">批量修改</button><button class="task-link" @click="selected=[]">取消选择</button></div>
      <nav v-if="pageData && !loading && !error && view.display==='list'" class="task-pagination" aria-label="任务分页">
        <span>共 {{pageData.total}} 项任务 · 第 {{pageData.page}} / {{Math.max(1,Math.ceil(pageData.total/pageData.pageSize))}} 页</span>
        <label>每页 <select v-model.number="view.pageSize" aria-label="每页任务数"><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option></select> 条</label>
        <button class="button" :disabled="loading || pageData.page<=1" @click="changePage(1)">首页</button>
        <button class="button" :disabled="loading || pageData.page<=1" @click="changePage(pageData.page-1)">上一页</button>
        <button class="button" :disabled="loading || pageData.page*pageData.pageSize>=pageData.total" @click="changePage(pageData.page+1)">下一页</button>
        <button class="button" :disabled="loading || pageData.page*pageData.pageSize>=pageData.total" @click="changePage(Math.ceil(pageData.total/pageData.pageSize))">末页</button>
      </nav>
      <footer class="task-page-footer"><span>执行计划 V{{workspace.planVersion}}</span><span>清晰的责任，让协作向前一步。</span></footer>
      <TaskDateFilterDialog v-if="dateOpen" :value="{dateMode:view.dateMode,dateFrom:view.dateFrom,dateTo:view.dateTo}" :is-demo="workspace.project.isDemo" :as-of="workspace.project.asOf" @close="dateOpen=false" @apply="applyDates" @clear="clearDates"/>
      <TaskDrawer ref="drawerRef" v-if="editor && (creating || currentTask)" :key="creating?'new':currentTask!.id" :workspace="editor" :task="creating?null:currentTask" :actor-id="view.actor" :initial-workstream-id="view.stream || undefined" :initial-action="initialAction" :initial-tab="route.query.taskTab === 'plan' ? 'plan' : 'detail'" :back-task-label="taskTrail.at(-1)?.title" @back-task="backTask" @plan-saved="planSaved" @close="closeDrawer" @manage-workstreams="navigateHandled({name:'workstreams'})" @saved="saved" @reload="async()=>{await load();await loadEditor()}" @show-plan="showPlan" @open-task="openRelatedTask" @delete-task="deletingTask=$event"/>
      <TaskRecycleDialog v-if="deletingTask && workspace" ref="recycleDialog" :workspace="workspace" :task-id="deletingTask.id" :actor-id="view.actor" operation="delete" @close="deletingTask=undefined" @saved="deleted"/>
      <dialog v-if="bulkOpen" ref="bulkDialog" class="task-bulk-dialog" aria-labelledby="task-bulk-title" @close="bulkOpen=false" @cancel="e=>{if(bulkBusy)e.preventDefault()}"><header><h2 id="task-bulk-title">{{bulkStage==='edit'?'批量修改任务':'确认批量修改'}}</h2><button class="icon-button" aria-label="关闭批量修改" :disabled="bulkBusy" @click="bulkDialog?.close()"><Icon name="close"/></button></header><div class="task-bulk-body"><p>本次范围：{{bulkTasks.length}} 项任务。全部通过校验后统一保存，失败时不会只改一部分。</p><ul><li v-for="t in bulkTasks" :key="t.id">{{t.wbs}} {{t.title}}</li></ul><form v-if="bulkStage==='edit'" id="task-bulk-form" @submit.prevent="reviewBulk"><label>修改字段<select v-model="bulkKind" @change="bulkValue=bulkKind==='priority'?'P1':''"><option value="priority">优先级</option><option value="owner">负责人</option></select></label><label>修改为<select v-model="bulkValue" required><template v-if="bulkKind==='priority'"><option value="P0">P0 · 紧急</option><option value="P1">P1 · 高</option><option value="P2">P2 · 普通</option></template><template v-else><option value="" disabled>选择负责人</option><option v-for="person in workspace.actors.filter(p=>p.assignable!==false && p.role!=='viewer')" :key="person.id" :value="person.id">{{person.name}}</option></template></select></label><label>修改原因<textarea v-model="bulkReason" required maxlength="500" rows="3" placeholder="说明本次批量调整的原因"></textarea></label></form><template v-else><dl><dt>{{bulkKind==='priority'?'优先级':'负责人'}}统一调整为</dt><dd>{{bulkKind==='priority'?bulkValue:workspace.actors.find(a=>a.id===bulkValue)?.name}}</dd><dt>原因</dt><dd>{{bulkReason}}</dd></dl><p>操作人：{{actor?.name}}{{ workspace.project.isDemo ? '（DEMO）' : '' }}。已完成、取消或无权限的任务会阻止整个批次保存。</p></template><p v-if="bulkError" class="task-page-error" role="alert">{{bulkError}}</p></div><footer><button class="button" :disabled="bulkBusy" @click="bulkStage==='confirm'?bulkStage='edit':bulkDialog?.close()">{{bulkStage==='confirm'?'返回修改':'取消'}}</button><button v-if="bulkStage==='edit'" class="button primary" form="task-bulk-form">核对修改范围</button><button v-else class="button primary" :disabled="bulkBusy" @click="applyBulk">{{bulkBusy?'正在保存…':`确认修改 ${bulkTasks.length} 项任务`}}</button></footer></dialog>
    </template>
  </section>
</template>
