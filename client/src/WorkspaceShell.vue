<script setup lang="ts">
import { privateModule, visibleTarget } from './utils/module-privacy';
import BrandLogo from './components/BrandLogo.vue';
import { RouterLink, useRoute, useRouter } from 'vue-router';
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import NotificationPanel from './features/notifications/NotificationPanel.vue';
import { useProjectRefresh } from './stores/useProjectRefresh';
import type { ProjectNotification } from '../../shared/src/notifications';
import ProjectSwitcher from './features/projects/ProjectSwitcher.vue';
import { currentProjectId } from './stores/project-scope';
import { useAuthStore } from './stores/auth';
import Icon from './components/Icon.vue';
import DetailDrawer from './components/DetailDrawer.vue';
import ActivityDrawer from './features/activities/ActivityDrawer.vue';
import { useContextStore } from './stores/context';
import { useSearchNavigation } from './stores/search-navigation';
import { fetchOverview } from './api/http';
import type { PublicProjectOverview as ProjectOverview } from '../../shared/src/contracts';
import type { DetailRequest } from './types';

const context = useContextStore();
const auth = useAuthStore();
const emit = defineEmits<{ account: []; logout: []; createProject: [] }>();
const userMenuOpen = ref(false);
const isLegacy = computed(() => Boolean(auth.session?.legacyDemo));
const route = useRoute(), router = useRouter();
const data = ref<ProjectOverview | null>(null);
const loading = ref(true);
const error = ref('');
const detail = ref<DetailRequest | null>(null);
const toast = ref('');
const collaboration = useProjectRefresh();
const shellProjectId = currentProjectId();
const capabilities = computed(() => auth.capabilities(shellProjectId));
const routeDenied = computed(() => { const module = privateModule(route.name); return !!module && !capabilities.value[module]; });
const searchRefreshing = ref(false), searchError = ref('');
let searchRefreshController: AbortController | undefined;
async function refreshSearch() {
  searchRefreshController?.abort();
  const controller = searchRefreshController = new AbortController();
  searchRefreshing.value = true; searchError.value = '';
  try { const result = await fetchOverview(controller.signal); if (!controller.signal.aborted) data.value = result; }
  catch (e) { if (!controller.signal.aborted) searchError.value = '搜索结果暂时无法更新，当前显示上次结果。'; }
  finally { if (!controller.signal.aborted) searchRefreshing.value = false; }
}
const search = useSearchNavigation({
  projectId: shellProjectId, account: () => auth.user?.id || 'legacy',
  show: () => { detail.value = { kind: 'search', title: '搜索项目内容' }; },
  hide: () => { detail.value = null; }, refresh: refreshSearch, notify,
});
const searchState = search.state, searchBusy = search.busy;
function closeDetail() { detail.value = null; search.reset(); searchRefreshController?.abort(); searchError.value = ''; searchRefreshing.value = false; }
onUnmounted(() => searchRefreshController?.abort());
collaboration.setScope(shellProjectId);
if (!isLegacy.value) collaboration.actorId.value = auth.actorForProject(shellProjectId);
else if (!collaboration.actorId.value) collaboration.actorId.value = 'zhou';
const { unread, pending: updatePending, error: refreshError, checking } = collaboration;
const activePage = ref<{ refreshForCollaboration?: () => Promise<boolean> }>();
const updating = ref(false);
const notificationsOpen = computed(() => route.query.notifications === 'open');
function openNotifications() { router.push({ path: route.path, query: { ...route.query, notifications: 'open' } }); }
function closeNotifications() { const { notifications: _value, ...query } = route.query; return router.replace({ path: route.path, query }); }
async function notificationTarget(target: ProjectNotification['target']) {
  if (!visibleTarget(target.kind, capabilities.value)) return;
  await closeNotifications();
  if (target.kind === 'milestone') { await router.push({ name:'plan', query:{view:'milestones', ...(target.id ? {milestone:target.id} : {})} }); return; }
  if (target.kind === 'risk' && target.id?.startsWith('alert-')) { await router.push({ name: 'risks', query: { alertId: target.id } }); return; }
  if (target.kind === 'workstreams') { await router.push({ name: 'workstreams', query: target.id ? { groupId: target.id } : {} }); return; }
  await router.push(target.kind === 'task' && target.id ? { name: 'task-detail', params: { taskId: target.id } } : target.kind === 'risk' && target.id ? { name: 'risk-detail', params: { riskId: target.id } } : { name: target.kind === 'task' ? 'tasks' : target.kind === 'risk' ? 'risks' : target.kind });
}
async function refreshCurrentPage() {
  if (updating.value) return;
  if (document.querySelector('dialog[open]') || detail.value) { notify('请先完成或关闭当前编辑与确认界面，草稿会保留。'); return; }
  updating.value = true;
  const version = collaboration.revision.value;
  try {
    const success = await activePage.value?.refreshForCollaboration?.();
    if (success === false) return;
    await load();
    if (!error.value) { collaboration.acknowledge(version); notify('当前页面已更新，筛选条件已保留。'); }
  } finally { updating.value = false; }
}

const smallScreen = ref(window.innerWidth < 768);
const sidebar = ref<HTMLElement>();
let menuTrigger: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout>;
let controller: AbortController | undefined;
const nav = computed(() => [
  { name: '项目总览', icon: 'grid', route: 'overview' },
  { name: '完整计划', icon: 'plan', route: 'plan' },
  { name: '工作分组', icon: 'layers', route: 'workstreams' },
  { name: '任务管理', icon: 'task', route: 'tasks' },
  { name: '统计分析', icon: 'chart', route: 'analytics' },
  { name: '风险中心', icon: 'shield', route: 'risks' },
].filter(item => { const module = privateModule(item.route); return !module || capabilities.value[module]; }));
function notify(message: string) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.value = '', 3600); }
function inspect(request: DetailRequest) { if (request.kind === 'risks' && !capabilities.value.risks) return; if (request.kind === 'milestones') { void router.push({name:'plan',query:{view:'milestones',...(request.filter ? {milestone:request.filter} : {})}}); } else if (request.kind === 'tasks') { if (request.filter && !['done','overdue','pending'].includes(request.filter)) router.push({name:'task-detail',params:{taskId:request.filter}}); else router.push({ name: 'tasks', query: request.filter ? { filter: request.filter } : {} }); } else if (request.kind === 'risks') { if (request.filter && !['high','urgent'].includes(request.filter)) router.push({name:'risk-detail',params:{riskId:request.filter}}); else router.push({name:'risks',query:request.filter ? {level:'urgent'} : {}}); } else if (request.kind === 'plan') router.push({ name: 'plan' }); else detail.value = request; context.mobileMenu = false; }
function navigate(name: string, title: string) { if (name) { router.push({ name }); context.mobileMenu = false; } else notify(`${title}正在准备中。`); }
async function load(refresh = false) {
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = '';
  const request = controller;
  try { const result = await fetchOverview(request.signal); if (request.signal.aborted) return; data.value = result; if (refresh) notify('项目总览已刷新。'); }
  catch (e) { if ((e as Error).name !== 'AbortError') error.value = e instanceof Error ? e.message : '暂时无法加载，请重试。'; }
  finally { loading.value = false; }
}
function shortcuts(event: KeyboardEvent) {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (!document.querySelector('dialog[open]')) inspect({ kind: 'search', title: '搜索项目内容' }); }
  if (event.key === 'Escape') context.mobileMenu = false;
  if (event.key === 'Tab' && context.mobileMenu && smallScreen.value) {
    const items = Array.from(sidebar.value?.querySelectorAll<HTMLElement>('a,button:not([disabled])') || []).filter(el => el.offsetParent !== null);
    const first = items[0], last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  }
}
function resize() { smallScreen.value = window.innerWidth < 768; if (!smallScreen.value) context.mobileMenu = false; }
watch(() => context.mobileMenu, async open => {
  document.body.style.overflow = open ? 'hidden' : '';
  if (open) { menuTrigger = document.activeElement as HTMLElement; await nextTick(); sidebar.value?.querySelector<HTMLElement>('a,button')?.focus(); }
  else { await nextTick(); menuTrigger?.focus(); }
});
onMounted(() => { load(); collaboration.start(); window.addEventListener('keydown', shortcuts); window.addEventListener('resize', resize); });
onUnmounted(() => { collaboration.stop(); controller?.abort(); clearTimeout(toastTimer); document.body.style.overflow = ''; window.removeEventListener('keydown', shortcuts); window.removeEventListener('resize', resize); });
</script>

<template>
  <div class="app-shell" :class="{ 'sidebar-collapsed': context.collapsed, 'menu-open': context.mobileMenu }">
    <a class="skip-link" href="#main-content">跳到主要内容</a>
    <button v-if="context.mobileMenu" class="mobile-scrim" aria-label="关闭导航" @click="context.mobileMenu = false"></button>
    <aside ref="sidebar" class="sidebar" aria-label="主导航" :inert="smallScreen && !context.mobileMenu">
      <RouterLink class="brand" :to="isLegacy ? {name:'overview',params:{projectId:shellProjectId}} : {name:'workspace'}" aria-label="GooodWork 项目列表">
        <BrandLogo />
      </RouterLink>
      <div class="workspace-label"><span>工作空间</span><span class="workspace-dot"></span></div>
      <nav>
        <button v-for="item in nav" :key="item.name" class="nav-item" :aria-label="item.name" :class="{ active: (item.route === route.name || item.route === 'tasks' && ['task-detail','task-recycle'].includes(String(route.name)) || item.route === 'risks' && route.name === 'risk-detail') }" :aria-current="(item.route === route.name || item.route === 'tasks' && ['task-detail','task-recycle'].includes(String(route.name)) || item.route === 'risks' && route.name === 'risk-detail') ? 'page' : undefined" :title="context.collapsed ? item.name : undefined" @click="navigate(item.route, item.name)">
          <Icon :name="item.icon" :size="19"/><span class="nav-label">{{ item.name }}</span><span v-if="!item.route" class="nav-pending">待实施</span>
        </button>
        <div class="nav-divider"></div>
        <button v-if="capabilities.settings" class="nav-item" aria-label="成员与设置" title="成员与设置" :class="{ active: route.name === 'settings' }" :aria-current="route.name === 'settings' ? 'page' : undefined" @click="navigate('settings', '成员与设置')"><Icon name="settings" :size="19"/><span class="nav-label">成员与设置</span></button>
      </nav>
      <div class="sidebar-bottom">
        <div class="preview-note"><span class="preview-tag"><span></span> {{ data?.project.isDemo ? '项目体验预览' : '项目工作空间' }}</span><p>从共同的目标，<br>到清晰的每一步。</p><button @click="inspect({ kind: 'goals', title: '项目目标' })">了解项目目标 <Icon name="arrow" :size="15"/></button></div>
        <button class="sidebar-help" @click="inspect({ kind: 'project', title: '工作空间说明' })"><Icon name="book" :size="17"/><span>项目指南</span><Icon name="chevron" :size="14"/></button>
        <div class="sidebar-footer"><span>GooodWork <small>v0.1</small></span><button class="icon-button" :aria-label="context.collapsed ? '展开侧栏' : '收起侧栏'" @click="context.toggleSidebar"><Icon name="collapse" :size="17"/></button></div>
      </div>
    </aside>
    <div class="workspace" :inert="smallScreen && context.mobileMenu">
      <header class="topbar">
        <button class="icon-button mobile-menu-button" aria-label="打开导航" @click="context.mobileMenu = true"><Icon name="menu"/></button>
        <div class="breadcrumb"><Icon name="folder" :size="17"/><span>我的项目</span><Icon name="chevron" :size="13"/><button v-if="isLegacy" class="project-switch" @click="inspect({ kind: 'project', title: '当前项目' })">{{ data?.project.name || '正在读取项目' }} <span v-if="data?.project.isDemo" class="demo-label">DEMO · 示例项目</span> <Icon name="down" :size="14"/></button><ProjectSwitcher v-else :is-demo="data?.project.isDemo" :name="data?.project.name || auth.session?.projects.find(p=>p.id===shellProjectId)?.name || '正在读取项目'" @create="emit('createProject')"/></div>
        <div class="topbar-actions"><button class="global-search" :aria-label="capabilities.risks ? '搜索任务与风险' : '搜索任务'" @click="inspect({ kind: 'search', title: '搜索项目内容' })"><Icon name="search" :size="17"/><span>{{ capabilities.risks ? '搜索任务、风险...' : '搜索任务、负责人...' }}</span><kbd>⌘ K</kbd></button>
          <button class="icon-button notification-button" aria-label="站内通知" :aria-expanded="notificationsOpen" @click="openNotifications"><Icon name="bell"/><span v-if="unread" class="notification-count" aria-live="polite">{{ unread > 99 ? '99+' : unread }}</span></button>
          <span class="topbar-separator"></span>
          <button v-if="isLegacy" class="user-menu" aria-label="查看体验身份" @click="inspect({ kind: 'project', title: '首页预览 · 体验身份' })"><span class="avatar avatar-blue">周</span><span class="user-name">周亦安<small>项目负责人 · 示例</small></span><Icon name="down" :size="13"/></button>
        <div v-if="!isLegacy" class="signed-user-menu">
            <button class="user-menu" aria-label="用户菜单" :aria-expanded="userMenuOpen" @click="userMenuOpen = !userMenuOpen"><span class="avatar avatar-blue">{{ auth.user?.name.slice(0,1) }}</span><span class="user-name">{{ auth.user?.name }}<small>{{ auth.user?.systemRole === 'admin' ? '系统管理员' : '已登录' }}</small></span><Icon name="down" :size="13"/></button>
            <div v-if="userMenuOpen" class="signed-menu-items" @keydown.esc="userMenuOpen=false"><strong>{{ auth.user?.username }}</strong><button @click="userMenuOpen=false;emit('account')">我的账号 / 修改密码</button><button v-if="auth.user?.systemRole==='admin'" @click="userMenuOpen=false;router.push({name:'users'})">用户管理</button><button v-if="auth.user?.systemRole==='admin'" @click="userMenuOpen=false;router.push({name:'system-settings',query:{returnTo:route.fullPath}})">系统设置</button><button @click="userMenuOpen=false;emit('logout')">退出登录</button></div>
          </div></div>
      </header>
      <main id="main-content" tabindex="-1">
        <div v-if="updatePending || refreshError" class="collaboration-banner" role="status">
          <span>{{ refreshError || '项目有新版本。更新当前页面后查看，正在编辑的内容会保留。' }}</span>
          <button v-if="refreshError" class="button" :disabled="checking" @click="collaboration.check">重新检查</button>
          <button v-if="updatePending" class="button" :disabled="updating" @click="refreshCurrentPage">{{ updating ? '正在更新…' : '更新当前页面' }}</button>
        </div>
        <section v-if="routeDenied" class="error-state" role="alert" data-testid="module-access-denied"><h1>无权访问此模块</h1><p>当前角色可继续协作任务、完整计划与工作分组。请联系项目负责人申请管理权限。</p><button class="button primary" @click="router.replace({name:'overview',query:{}})">返回项目总览</button></section>
        <div v-else-if="!data && loading" class="loading-layout" role="status"><div class="loading-line"></div><div class="loading-cards"><i v-for="n in 4" :key="n"></i></div><div class="loading-panel"></div><p>正在读取项目概览...</p></div>
        <div v-else-if="error" class="error-state" role="alert"><span class="error-icon"><Icon name="refresh" :size="30"/></span><h1>项目数据暂时没有加载成功</h1><p>{{ error }}</p><button class="button primary" @click="load()">重新加载</button></div>
        <RouterView v-else-if="data" v-slot="{ Component }"><component :is="Component" ref="activePage" :data="data" :refreshing="loading" @inspect="inspect" @refresh="load(true)" @overview-changed="load()" @notify="notify"/></RouterView>
      </main>
    </div>
    <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><Icon name="info" :size="18"/>{{ toast }}</div></Transition>
    <NotificationPanel v-if="notificationsOpen" @close="closeNotifications" @notify="notify" @navigate="notificationTarget"/>
    <ActivityDrawer v-if="detail?.kind === 'activity' && data" :project-id="data.project.id" :project-name="data.project.name" :is-demo="data.project.isDemo" :initial="detail.activity" @close="detail = null"/>
    <DetailDrawer v-else-if="detail && data" :request="detail" :data="data" v-model:search-state="searchState" :search-busy="searchBusy" :search-refreshing="searchRefreshing" :search-error="searchError" @open-task="search.openTask" @retry-search="refreshSearch" @close="closeDetail"/>
  </div>
</template>

<style scoped>
.signed-user-menu{position:relative}.signed-menu-items{position:absolute;right:0;top:52px;z-index:80;min-width:220px;padding:8px;background:var(--surface);border:1px solid var(--line-strong);border-radius:12px;box-shadow:0 8px 32px #1b223326;display:grid}.signed-menu-items strong{padding:12px;color:var(--secondary)}.signed-menu-items button{text-align:left;padding:12px;min-height:44px;border-radius:8px}.signed-menu-items button:hover{background:var(--primary-soft)}

.notification-count { position: absolute; top: 0; right: -4px; min-width: 17px; height: 17px; padding: 0 3px; border-radius: 12px; background: var(--primary); color: white; font-size: 10px; line-height: 17px; }
.collaboration-banner { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; padding: 12px 16px; margin: 16px 24px 0; background: var(--primary-soft); border-radius: 12px; font-size: 13px; }
.collaboration-banner span { flex: 1 1 220px; }
@media (max-width: 767px) { .collaboration-banner { margin: 12px 16px 0; } }
</style>
