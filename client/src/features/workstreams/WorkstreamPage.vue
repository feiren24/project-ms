<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { currentProjectId, useProjectView } from '../../stores/project-scope';
import { fetchWorkstreams, type WorkstreamOperation } from '../../api/workstreams';
import type { ManagedWorkstream, WorkstreamWorkspace } from '../../../../shared/src/workstreams';
import WorkstreamDialog from './WorkstreamDialog.vue';
import Icon from '../../components/Icon.vue';
import './workstreams.css';
const auth = useAuthStore(), router = useRouter(), route = useRoute(), projectId = currentProjectId();
const view = useProjectView('workstreams', () => ({ query: '', state: 'all', actor: 'zhou' }));
const isLegacy = computed(() => Boolean(auth.session?.legacyDemo));
watch(() => auth.actorForProject(projectId), actor => { if (!isLegacy.value) view.actor = actor; }, { immediate: true });
const emit = defineEmits<{ notify: [message: string]; 'overview-changed': [] }>();
const workspace = ref<WorkstreamWorkspace>(), loading = ref(false), error = ref('');
const operation = ref<WorkstreamOperation>(), selected = ref<ManagedWorkstream>();
let controller: AbortController | undefined, sequence = 0, disposed = false;
const canManage = computed(() => workspace.value?.canManage && (isLegacy.value || !!auth.actorForProject(projectId)));
const all = computed(() => [...(workspace.value?.workstreams || [])].sort((a,b) => a.position - b.position));
const filtered = computed(() => all.value.filter(item => (view.state === 'all' || (view.state === 'active' ? item.active : !item.active)) && (!view.query.trim() || `${item.name} ${item.description} ${item.owner || ''}`.toLowerCase().includes(view.query.trim().toLowerCase()))));
const filterActive = computed(() => !!view.query.trim() || view.state !== 'all');
const historyNames: Record<string,string> = { create: '新增分组', update: '编辑分组', enable: '启用分组', disable: '停用分组', move: '调整顺序', reorder: '调整顺序' };
async function load() {
 if (operation.value || disposed) return false;
 controller?.abort(); controller = new AbortController(); const request = ++sequence; loading.value = true; error.value = '';
 try { const result = await fetchWorkstreams(projectId, view.actor, controller.signal); if (disposed || request !== sequence) return false; workspace.value = result; return true; }
 catch (e) { if (!disposed && request === sequence && (e as Error).name !== 'AbortError') error.value = e instanceof Error ? e.message : '工作分组暂时无法读取，请重试。'; return false; }
 finally { if (!disposed && request === sequence) loading.value = false; }
}
function open(mode: WorkstreamOperation, item?: ManagedWorkstream) { if (!canManage.value || loading.value) return; selected.value = item; operation.value = mode; }
function tasks(item: ManagedWorkstream) { router.push({ name: 'tasks', params: { projectId }, query: { workstreamId: item.id } }); }
function saved(result: WorkstreamWorkspace, message: string) { if (disposed) return; workspace.value = result; operation.value = undefined; selected.value = undefined; emit('overview-changed'); emit('notify', message); }
function clear() { view.query = ''; view.state = 'all'; }
async function locate() { if (typeof route.query.groupId !== 'string') return; clear(); await nextTick(); if (!disposed) document.getElementById(`workstream-${route.query.groupId}`)?.scrollIntoView({ block: 'center' }); }
onMounted(async () => { await load(); await locate(); });
watch(() => route.query.groupId, locate);
onBeforeUnmount(() => { disposed = true; ++sequence; controller?.abort(); });
defineExpose({ refreshForCollaboration: load });
</script>
<template>
 <section class="wg-page" aria-labelledby="workstreams-title">
  <header class="wg-heading"><div><span class="eyebrow">WORK GROUPS</span><h1 id="workstreams-title">工作分组<span></span></h1><p>把相关任务归在一起，明确范围与协调责任。</p></div><div class="wg-heading-actions"><button class="button" :disabled="loading || !!operation" @click="load">刷新分组</button><button v-if="canManage" class="button primary" :disabled="loading" @click="open('create')">＋ 新增工作分组</button></div></header>
  <div class="wg-intro"><Icon name="layers" :size="19"/><p>工作分组用于组织任务，不改变任务的状态流转。停用只限制新增归入，已有工作继续执行。</p><label v-if="isLegacy">体验身份<select v-model="view.actor" aria-label="工作分组体验身份" :disabled="loading || !!operation" @change="load"><option v-for="actor in workspace?.actors || []" :key="actor.id" :value="actor.id">{{ actor.name }}</option></select></label></div>
  <div v-if="workspace" class="wg-metrics"><article><span>全部分组</span><strong>{{ all.length }}</strong><small>当前项目的任务分类</small></article><article><span>启用中</span><strong>{{ all.filter(item => item.active).length }}</strong><small>可以新增归入任务</small></article><article><span>已停用</span><strong>{{ all.filter(item => !item.active).length }}</strong><small>历史和已有任务保留</small></article><article><span>未完成执行任务</span><strong>{{ all.reduce((sum,item) => sum + item.unfinishedCount,0) }}</strong><small>汇总父任务不重复计算</small></article></div>
  <div class="wg-tools"><label class="wg-search"><span class="sr-only">搜索工作分组</span><input v-model="view.query" type="search" aria-label="搜索工作分组" placeholder="搜索名称、说明或协调负责人"/></label><select v-model="view.state" aria-label="工作分组状态筛选"><option value="all">全部状态</option><option value="active">仅启用</option><option value="inactive">仅停用</option></select><button v-if="filterActive" class="wg-link" @click="clear">清除筛选</button></div>
  <p v-if="error" class="project-error" role="alert">{{ error }}<button class="wg-link" :disabled="loading" @click="load">重新读取</button></p>
  <p v-if="loading && !workspace" class="wg-empty" role="status">正在读取项目工作分组…</p>
  <template v-if="workspace">
   <p v-if="!canManage" class="wg-field-note">当前为只读查看。工作分组由项目负责人或项目管理员维护。</p><p v-else-if="filterActive" class="wg-field-note">当前显示筛选结果，清除筛选后可调整全部分组的顺序。</p>
   <div v-if="filtered.length" class="wg-list"><div class="wg-table-heading" aria-hidden="true"><span>工作分组</span><span>协调负责人</span><span>执行任务</span><span>排序 / 操作</span></div><article v-for="item in filtered" :id="`workstream-${item.id}`" :key="item.id" class="wg-row" :class="{ 'wg-highlight': route.query.groupId === item.id }" data-testid="workstream-row"><div class="wg-group"><span class="wg-symbol" :data-color="item.color"><Icon name="layers" :size="20"/></span><div><h2>{{ item.name }}<span class="wg-status" :class="{ inactive: !item.active }">{{ item.active ? '启用' : '已停用' }}</span></h2><p>{{ item.description || '暂未填写分组说明' }}</p></div></div><div class="wg-owner"><span class="wg-mobile-label">协调负责人</span><strong>{{ item.owner || '未指定' }}</strong><small v-if="item.ownerId && !workspace.actors.some(actor => actor.id === item.ownerId)">原负责人已不可用，请调整</small></div><div class="wg-count"><span class="wg-mobile-label">执行任务</span><b>{{ item.taskCount }} 项</b><small>{{ item.unfinishedCount }} 项未完成</small></div><div class="wg-actions"><button class="wg-link" :aria-label="`查看${item.name}任务`" @click="tasks(item)">查看任务</button><template v-if="canManage"><button class="wg-link" :aria-label="`编辑${item.name}`" :disabled="loading" @click="open('edit',item)">编辑</button><div class="wg-order"><button :aria-label="`上移${item.name}`" :disabled="loading || filterActive || all[0]?.id === item.id" @click="open('up',item)">↑</button><button :aria-label="`下移${item.name}`" :disabled="loading || filterActive || all.at(-1)?.id === item.id" @click="open('down',item)">↓</button></div><button class="wg-link" :class="{ 'wg-disable': item.active }" :disabled="loading" :aria-label="`${item.active ? '停用' : '启用'}${item.name}`" @click="open('status',item)">{{ item.active ? '停用' : '启用' }}</button></template></div></article></div>
   <div v-else class="wg-empty"><Icon name="layers" :size="28"/><h2>{{ filterActive ? '没有匹配的工作分组' : '还没有工作分组' }}</h2><p>{{ filterActive ? '调整关键词或状态，查看其他分组。' : '先建立工作分组，再创建和安排任务。' }}</p><button v-if="filterActive" class="button" @click="clear">清除筛选</button><button v-else-if="canManage" class="button primary" @click="open('create')">新增工作分组</button></div>
   <details class="wg-history"><summary>分组变更记录 <span>{{ workspace.history.length }} 条</span></summary><article v-for="event in [...workspace.history].sort((a,b)=>b.createdAt.localeCompare(a.createdAt))" :key="event.id"><div><b>{{ historyNames[event.action.replace(/^workstream\./, '')] || '工作分组更新' }}</b><span>{{ all.find(item => item.id === event.workstreamId)?.name || '工作分组' }}</span></div><p>{{ event.reason }}</p><small>{{ event.actor }} · {{ new Date(event.createdAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) }}</small></article><p v-if="!workspace.history.length" class="wg-field-note">暂无分组变更记录。新增、编辑、排序和启停后将在这里留痕。</p></details>
   <footer class="wg-footer">分组版本 V{{ workspace.version }} · 当前计划 V{{ workspace.planVersion }}</footer>
   <WorkstreamDialog v-if="operation" :workspace="workspace" :actor-id="view.actor" :operation="operation" :stream="selected" @close="operation=undefined;selected=undefined" @saved="saved"/>
  </template>
 </section>
</template>
