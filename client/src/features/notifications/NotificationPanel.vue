<script setup lang="ts">
import { projectRoleLabels, canWriteProject } from '../../../../shared/src/permissions';

import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
const auth = useAuthStore();
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BackgroundJob, NotificationWorkspace, ProjectNotification } from '../../../../shared/src/notifications';
import { fetchNotifications, markNotificationsRead, retryNotificationJob } from '../../api/notifications';
import { fetchSettings } from '../../api/settings';
import { PlanningError } from '../../api/planning';
import { useProjectRefresh } from '../../stores/useProjectRefresh';
import '../tasks/task-drawer.css';
import './notification-panel.css';
const emit = defineEmits<{ close: []; notify: [message: string]; navigate: [target: ProjectNotification['target']] }>();
const refresh = useProjectRefresh();
const { actorId, actors } = refresh;
const dialog = ref<HTMLDialogElement>(), workspace = ref<NotificationWorkspace | null>(null), loading = ref(false), busy = ref(false), error = ref(''), notice = ref('');
const tab = ref<'notifications' | 'jobs'>('notifications'), filter = ref<'unread' | 'all'>('unread'), stale = ref(false), confirmed = ref(false);
type Intent = { kind: 'read'; body: { ids: string[] } | { all: true }; label: string } | { kind: 'retry'; jobId: string; label: string };
const intent = ref<Intent | null>(null);
const roleNames = projectRoleLabels;
const jobNames: Record<BackgroundJob['kind'], string> = { notification: '站内通知投递', risk_evaluate: '风险预警巡检', snapshot: '日终统计快照', backup: '本机数据备份', feishu_delivery: '飞书机器人投递' };
const jobStates: Record<BackgroundJob['status'], string> = { pending: '等待执行', running: '执行中', succeeded: '执行成功', failed: '执行失败', missed: '已错过' };
const displayed = computed(() => workspace.value?.notifications.filter(item => filter.value === 'all' || !item.readAt) || []);
const selectedJob = computed(() => intent.value?.kind === 'retry' ? workspace.value?.jobs.find(job => job.id === (intent.value as Extract<Intent, { kind: 'retry' }>).jobId) : undefined);
const writable = computed(() => canWriteProject((workspace.value?.actors || actors.value).find(a => a.id === actorId.value)?.role));
const canExecute = computed(() => !!workspace.value && writable.value && !stale.value && (!intent.value || intent.value.kind !== 'retry' || (workspace.value.canManageJobs && selectedJob.value?.status === 'failed')));
const dateTime = (date: string) => new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
let sequence = 0, controller: AbortController | undefined, requestKey = '', trigger: HTMLElement | null = null;
async function load(recover = false) {
  if (busy.value) return;
  const actor = actorId.value, loadSequence = ++sequence;
  controller?.abort(); controller = new AbortController(); loading.value = true; error.value = ''; notice.value = '';
  try {
    const result = await fetchNotifications(actor, controller.signal);
    if (loadSequence !== sequence || actor !== actorId.value) return;
    if (result.actorId !== actor) throw new Error('通知收件人与当前账号不一致，请重新读取。');
    workspace.value = result; refresh.updateUnread(result);
    if (!result.canManageJobs && tab.value === 'jobs') tab.value = 'notifications';
    if (recover) { stale.value = false; confirmed.value = false; requestKey = ''; notice.value = '已重新读取当前通知、作业状态与操作凭证。待处理操作已保留，请重新核对后确认，不会自动重试。'; }
    void refresh.check();
  } catch (e) {
    if (loadSequence !== sequence || actor !== actorId.value || (e as Error).name === 'AbortError') return;
    const denied = e instanceof PlanningError && e.status === 403;
    error.value = denied ? (auth.session?.legacyDemo ? '当前通知体验身份已停用或不可用，请明确选择有效成员后重新读取。不会自动切换身份。' : '当前账号的通知访问权限已变化，请重新登录或联系项目负责人。') : e instanceof Error ? e.message : '读取失败，请重试。';
    if (denied) {
      workspace.value = null; refresh.updateUnread({ actorId: actor, unread: 0, actors: actors.value });
      if (auth.session?.legacyDemo) try { const result = await fetchSettings(); if (loadSequence === sequence && actor === actorId.value) actors.value = result.actors; } catch { /* Leave the failed-read recovery control available. */ }
    }
  } finally { if (loadSequence === sequence) loading.value = false; }
}
function clearIntent() { if (busy.value) return; intent.value = null; confirmed.value = false; stale.value = false; requestKey = ''; error.value = ''; notice.value = ''; }
function review() { if (!canExecute.value || !intent.value || busy.value || loading.value) return; confirmed.value = true; nextTick(() => dialog.value?.querySelector<HTMLElement>('.notification-confirm')?.focus()); }
function stageRetry(job: BackgroundJob) {
  if (!workspace.value?.canManageJobs || job.kind === 'feishu_delivery' || job.status !== 'failed' || intent.value || busy.value) return;
  intent.value = { kind: 'retry', jobId: job.id, label: `${jobNames[job.kind]} · ${job.id}` }; error.value = ''; requestKey = ''; confirmed.value = true;
  nextTick(() => { const panel = dialog.value?.querySelector<HTMLElement>('.notification-confirm'); panel?.scrollIntoView({ block: 'nearest' }); panel?.focus(); });
}
async function mark(item?: ProjectNotification) {
  if (!writable.value || !workspace.value || busy.value || intent.value) return;
  intent.value = { kind: 'read', body: item ? { ids: [item.id] } : { all: true }, label: item ? `将「${item.title}」标为已读` : `将当前身份的全部未读通知标为已读（当前 ${workspace.value.unread} 条）` };
  requestKey = ''; confirmed.value = true; await execute();
}
async function execute() {
  if (!workspace.value || !intent.value || !confirmed.value || !canExecute.value || busy.value || loading.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  const actor = actorId.value, currentIntent = intent.value, currentWorkspace = workspace.value;
  if (!requestKey) requestKey = crypto.randomUUID();
  try {
    const result = currentIntent.kind === 'read' ? await markNotificationsRead(currentWorkspace, currentIntent.body, requestKey) : await retryNotificationJob(currentWorkspace, currentIntent.jobId, requestKey);
    if (actor !== actorId.value || result.actorId !== actor) return;
    workspace.value = result; refresh.updateUnread(result);
    intent.value = null; confirmed.value = false; requestKey = '';
    const message = currentIntent.kind === 'read' ? '已更新本机通知的已读状态。' : '失败作业已重新加入本机队列，执行结果请刷新查看。';
    notice.value = message; emit('notify', message); void refresh.check();
  } catch (e) {
    if (actor !== actorId.value) return;
    error.value = e instanceof Error ? e.message : '操作失败，请重试。';
    if (e instanceof PlanningError && [403, 409].includes(e.status)) { stale.value = true; confirmed.value = false; error.value += ' 请先重新读取最新记录和操作凭证，再核对确认。'; }
    else error.value += ' 操作已保留，可使用同一操作标识重试。';
    nextTick(() => dialog.value?.querySelector<HTMLElement>('.td-error')?.scrollIntoView({ block: 'nearest' }));
  } finally { busy.value = false; }
}
function close() { if (!busy.value) emit('close'); }
function navigate(item: ProjectNotification) { if (!busy.value && !intent.value) emit('navigate', item.target); }
watch(actorId, () => { sequence++; controller?.abort(); workspace.value = null; intent.value = null; confirmed.value = false; stale.value = false; requestKey = ''; tab.value = 'notifications'; filter.value = 'unread'; void load(); });
onMounted(() => { trigger = document.activeElement as HTMLElement; dialog.value?.showModal(); void load(); });
onBeforeUnmount(() => { sequence++; controller?.abort(); dialog.value?.close(); trigger?.focus(); });
const removeNavigationGuard = useRouter().beforeEach((to, from) => to.params.projectId === from.params.projectId ? true : !busy.value && (!intent.value || window.confirm('尚有未完成的通知操作，离开将取消本次操作。是否离开？')));
onBeforeUnmount(() => removeNavigationGuard());
</script>
<template>
<dialog ref="dialog" class="task-drawer notification-panel" aria-labelledby="notification-panel-title" @cancel.prevent="close" @click="event => { if (event.target === dialog) close(); }"><div class="td-shell">
 <header class="td-header"><div class="td-header-row"><span class="td-reference">{{ workspace?.project.name || '正在读取项目' }}<span v-if="workspace?.project.isDemo"> · DEMO · 示例项目</span></span><button class="td-icon-button" aria-label="关闭站内通知" :disabled="busy" @click="close">✕</button></div><h2 id="notification-panel-title">站内通知</h2><p class="td-stream">留意协作变化，回到原任务继续处理。</p></header>
 <div class="td-body">
  <section class="notification-identity"><span v-if="workspace?.project.isDemo" class="demo-label">DEMO</span><p>此处仅展示个人站内通知。项目飞书群通知由“成员与设置 → 通知与集成”单独管理。{{ auth.session?.legacyDemo ? '通知体验身份独立于业务页面。' : `当前收件人：${auth.user?.name || ''}，仅显示自己的通知。` }}</p><label v-if="auth.session?.legacyDemo" class="td-field">通知体验身份<select v-model="actorId" aria-label="通知体验身份" :disabled="busy"><option v-if="!actors.some(a => a.id === actorId)" :value="actorId" disabled>{{ actorId }} · 身份待核验或已失效</option><option v-for="actor in actors" :key="actor.id" :value="actor.id">{{ actor.name }} · {{ roleNames[actor.role] }}</option></select></label><p v-if="intent && !busy && auth.session?.legacyDemo" class="td-field-note">切换通知身份会取消当前待确认操作，不会更改通知内容或业务数据。</p></section>
  <div v-if="error" class="td-error" role="alert">{{ error }}<div class="td-inline-buttons"><button v-if="stale" class="button" :disabled="loading || busy" @click="load(true)">{{ loading ? '正在重新读取…' : '重新读取并保留操作' }}</button><button v-else-if="!intent" class="button" :disabled="loading" @click="load()">重新加载通知</button><button v-else class="button" :disabled="loading || busy" @click="execute">重试操作</button></div></div>
  <p v-if="notice" class="td-notice" role="status">{{ notice }}</p>
  <p v-if="loading" class="notification-loading" role="status">正在读取当前身份的通知与作业…</p>
  <template v-if="workspace">
   <nav class="notification-tabs" aria-label="通知面板视图"><button :aria-pressed="tab === 'notifications'" :class="{ active: tab === 'notifications' }" :disabled="busy || !!intent" @click="tab = 'notifications'">站内通知 <span>{{ workspace.unread }}</span></button><button v-if="workspace.canManageJobs" :aria-pressed="tab === 'jobs'" :class="{ active: tab === 'jobs' }" :disabled="busy || !!intent" @click="tab = 'jobs'">后台作业</button></nav>
   <section v-if="intent" class="td-action-panel notification-confirm" tabindex="-1" aria-labelledby="notification-confirm-title"><h3 id="notification-confirm-title">{{ intent.kind === 'retry' ? '确认重试失败作业' : '确认已读范围' }}</h3><p class="td-prose">{{ intent.label }}</p><p class="td-field-note">操作身份：{{ actors.find(a => a.id === actorId)?.name || actorId }}。</p><template v-if="intent.kind === 'retry'"><p class="td-prose">最新状态：{{ selectedJob ? jobStates[selectedJob.status] : '该作业已不在当前列表' }}</p><p class="td-field-note">重试会重新加入本机队列。尚未执行成功，不会重新运行成功作业，也不会补造错过日期的历史快照。</p><p v-if="!canExecute && !stale" class="td-warning-text">当前权限或作业状态不支持重试，请取消并查看最新列表。</p></template><div class="td-inline-buttons"><button class="button" :disabled="busy" @click="clearIntent">取消本次操作</button><button v-if="!confirmed && !stale" class="button primary" :disabled="!canExecute || loading || busy" @click="review">重新核对操作</button><button v-else-if="confirmed" class="button primary" :disabled="!canExecute || loading || busy" @click="execute">{{ busy ? '正在处理…' : intent.kind === 'retry' ? '确认重试' : '确认标为已读' }}</button></div></section>
   <section v-if="tab === 'notifications'" aria-label="通知列表"><div class="notification-toolbar"><nav aria-label="通知已读筛选"><button aria-label="未读通知" :aria-pressed="filter === 'unread'" :class="{ active: filter === 'unread' }" :disabled="busy || !!intent" @click="filter = 'unread'">未读</button><button aria-label="全部通知" :aria-pressed="filter === 'all'" :class="{ active: filter === 'all' }" :disabled="busy || !!intent" @click="filter = 'all'">全部</button></nav><button v-if="writable" class="td-text-button" :disabled="!workspace.unread || busy || !!intent || loading" @click="mark()">全部标为已读</button></div>
    <article v-for="item in displayed" :key="item.id" class="notification-row" :class="{ unread: !item.readAt }" data-testid="notification-row"><div class="notification-row-meta"><span>{{ item.readAt ? '已读' : '未读' }}</span><time>{{ dateTime(item.createdAt) }}</time></div><h3>{{ item.title }}</h3><p>{{ item.message }}</p><div class="notification-row-actions"><button class="td-text-button" :aria-label="`查看 ${item.title}`" :disabled="busy || !!intent" @click="navigate(item)">查看相关{{ { milestone: '里程碑', task: '任务', risk: '风险', plan: '计划', settings: '设置', workstreams: '工作分组' }[item.target.kind] }} ↗</button><button v-if="writable && !item.readAt" class="td-text-button" :aria-label="`标为已读 ${item.title}`" :disabled="busy || !!intent || loading" @click="mark(item)">标为已读</button></div></article>
    <div v-if="!displayed.length && !loading" class="td-empty"><h3>{{ filter === 'unread' && workspace.notifications.length ? '当前没有未读通知' : '当前身份暂无站内通知' }}</h3><p>{{ workspace.notifications.length ? '已读通知可在“全部”中查看，仍可回到相关任务。' : '后续与你相关的任务、风险或项目配置变化会在本机队列处理后显示；旧历史不会补发。' }}</p><button v-if="filter === 'unread' && workspace.notifications.length" class="button" @click="filter = 'all'">查看全部通知</button><button v-else class="button" :disabled="loading || !!intent" @click="load()">检查新通知</button></div>
   </section>
   <section v-else aria-label="后台作业列表"><p class="notification-job-note">本机持久队列 · 失败保留记录。飞书投递仅明确可重试失败自动重试，结果待核实须人工处理；其他失败作业最多自动重试 3 次。日终快照错过时刻会标记“已错过”，不会用当前数据补旧日期；备份仍保留在本机。</p><article v-for="job in workspace.jobs" :key="job.id" class="notification-job" data-testid="background-job"><div class="notification-row-meta"><strong>{{ jobNames[job.kind] }}</strong><span :class="{ 'notification-failed': job.status === 'failed' || job.status === 'missed' }">{{ jobStates[job.status] }}</span></div><h3>{{ job.summary || jobNames[job.kind] }}</h3><p class="notification-job-id">{{ job.id }}</p><p>计划时间：{{ dateTime(job.dueAt) }}<br/>已尝试 {{ job.attempts }} 次<span v-if="job.finishedAt"> · 最近结束 {{ dateTime(job.finishedAt) }}</span></p><p v-if="job.error" class="notification-job-error">{{ job.error }}</p><button v-if="job.status === 'failed' && job.kind !== 'feishu_delivery'" class="td-text-button" :aria-label="`重试作业 ${job.id}`" :disabled="busy || !!intent || loading" @click="stageRetry(job)">重试失败作业</button><p v-if="job.kind === 'feishu_delivery'" class="td-field-note">请到成员与设置 → 通知与集成 → 发送记录核对结果或恢复发送。</p><p v-if="job.status === 'missed' && job.kind !== 'feishu_delivery'" class="td-field-note">保留错过记录，不重建历史快照。</p></article><div v-if="!workspace.jobs.length && !loading" class="td-empty"><h3>暂无后台作业记录</h3><p>业务事件与后续调度会产生本机作业，可稍后刷新查看。</p></div></section>
  </template>
 </div>
 <footer class="td-footer"><span class="td-field-note">本机站内提醒 · 不改变当前业务页面</span><button class="button" aria-label="刷新通知" :disabled="loading || busy || !!intent" @click="load()">{{ loading ? '正在读取…' : '刷新通知' }}</button></footer>
</div></dialog>
</template>
