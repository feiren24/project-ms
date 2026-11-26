<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import type { ManagedTask, TaskWorkspace } from '../../../../shared/src/tasks';
import { fetchRecycledTask, fetchTaskDetail } from '../../api/tasks';
import { PlanningError } from '../../api/planning';
import TaskDrawer from './TaskDrawer.vue';
import TaskRecycleDialog from './TaskRecycleDialog.vue';

const props = defineProps<{
  projectId: string; taskId: string; actorId: string;
  initialTab?: 'detail'|'plan'|'children'|'activity';
  initialPlanEditing?: boolean; planProposal?: { start: string; end: string };
}>();
const emit = defineEmits<{
  close: []; changed: []; notify: [message: string];
  openTask: [id: string]; showPlan: [id: string]; manageWorkstreams: [];
}>();
const workspace = ref<TaskWorkspace | null>(null);
const task = computed(() => workspace.value?.tasks.find(item => item.id === props.taskId) ?? null);
const drawer = ref<InstanceType<typeof TaskDrawer>>(), recycle = ref<InstanceType<typeof TaskRecycleDialog>>();
const deleting = ref<ManagedTask>(), loading = ref(false), error = ref(''), deleted = ref(false), canViewDeleted = ref(false);
const statusDialog = ref<HTMLDialogElement>(), statusSuspended = ref(false);
const history = ref<Array<{ id: string; title: string }>>([]);
const previous = computed(() => history.value.at(-1));
let sequence = 0, disposed = false, internalTarget = '';

async function reload() {
  const request = ++sequence, { projectId, taskId, actorId } = props;
  loading.value = true; error.value = ''; statusSuspended.value = false; deleted.value = false; canViewDeleted.value = false;
  try {
    const result = await fetchTaskDetail(projectId, taskId, actorId);
    if (disposed || request !== sequence) return false;
    if (!result.tasks.some(item => item.id === taskId)) throw new Error('未找到这个任务，请返回计划重新选择。');
    // Never clear a same-task workspace while refreshing: TaskDrawer owns its drafts.
    workspace.value = result;
    return true;
  } catch (e) {
    if (disposed || request !== sequence) return false;
    error.value = e instanceof Error ? e.message : '任务详情暂时无法读取，请重试。';
    deleted.value = e instanceof PlanningError && e.code === 'TASK_DELETED';
    if (deleted.value) {
      try {
        await fetchRecycledTask(projectId, actorId, taskId);
        if (!disposed && request === sequence) canViewDeleted.value = true;
      } catch { /* The record link is offered only after its own access check succeeds. */ }
    }
    return false;
  } finally { if (!disposed && request === sequence) loading.value = false; }
}
watch(() => [props.projectId, props.taskId, props.actorId] as const, (value, old) => {
  if (!old || value[0] !== old[0] || value[1] !== old[1]) {
    workspace.value = null; deleting.value = undefined;
    if (old && value[0] === old[0]) {
      if (internalTarget !== value[1]) {
        const index = history.value.findIndex(item => item.id === value[1]);
        history.value = index < 0 ? [] : history.value.slice(0, index);
      }
    } else history.value = [];
    internalTarget = '';
  }
  void reload();
}, { immediate: true });

// TaskDrawer has already confirmed its close/related-task events. Do not prompt twice.
function openTask(id: string) {
  if (id === props.taskId) return;
  history.value.push({ id: props.taskId, title: task.value?.title || '上一项任务' });
  internalTarget = id; emit('openTask', id);
}
function backTask() {
  const target = history.value.pop();
  if (target) { internalTarget = target.id; emit('openTask', target.id); }
}
async function saved(message?: string) {
  await reload();
  if (disposed) return;
  emit('changed');
  if (message) emit('notify', message);
}
async function confirmNavigation() {
  // A load error may sit above a dirty drawer in the native dialog stack.
  // Let the drawer's own confirmation receive focus and pointer events.
  if (drawer.value && showStatus.value) {
    statusDialog.value?.close(); statusSuspended.value = true;
    await nextTick();
  }
  if (recycle.value) return recycle.value.confirmNavigation();
  const allowed = await drawer.value?.confirmNavigation() ?? true;
  if (!allowed && statusSuspended.value && error.value) emit('notify', `${error.value}；填写内容已保留，可重新读取任务。`);
  return allowed;
}
async function backFromStatus() { if (await confirmNavigation()) backTask(); }
async function closeStatus() { if (await confirmNavigation()) emit('close'); }
function deletedTask() {
  deleting.value = undefined;
  emit('changed'); emit('notify', '任务已移入回收站，删除原因已保存。'); emit('close');
}
const showStatus = computed(() => !statusSuspended.value && (!!error.value || (!task.value && loading.value)));
watch(showStatus, async visible => {
  await nextTick();
  if (visible) { if (!statusDialog.value?.open) statusDialog.value?.showModal(); }
  else statusDialog.value?.close();
}, { immediate: true });
onBeforeUnmount(() => { disposed = true; sequence++; statusDialog.value?.close(); });
defineExpose({ confirmNavigation, refresh: reload, isDirty: computed(() => !!drawer.value?.isDirty), isBusy: computed(() => loading.value || !!drawer.value?.isBusy || !!deleting.value) });
</script>
<template>
  <TaskDrawer v-if="workspace && task" ref="drawer" :key="`${projectId}:${task.id}`" :workspace="workspace" :task="task" :actor-id="actorId"
    :initial-tab="initialTab" :initial-plan-editing="initialPlanEditing" :plan-proposal="planProposal" :back-task-label="previous?.title"
    @back-task="backTask" @open-task="openTask" @close="emit('close')" @saved="saved" @plan-saved="saved()" @reload="saved()"
    @show-plan="emit('showPlan', $event)" @manage-workstreams="emit('manageWorkstreams')" @delete-task="deleting = $event"/>
  <TaskRecycleDialog v-if="deleting && workspace" ref="recycle" :workspace="workspace" :task-id="deleting.id" :actor-id="actorId" operation="delete" @close="deleting = undefined" @saved="deletedTask"/>
  <dialog v-if="showStatus" ref="statusDialog" class="plan-dialog" aria-labelledby="plan-task-status-title" @cancel.prevent="closeStatus">
    <header class="plan-dialog-header"><h2 id="plan-task-status-title">{{ deleted ? '任务已删除' : error ? '任务详情暂时无法加载' : '正在读取任务详情' }}</h2><button class="button" @click="closeStatus">返回计划</button></header>
    <div class="plan-dialog-body"><p v-if="error" role="alert">{{ error }}</p><p v-else role="status">正在读取当前项目中的任务及关联信息…</p></div>
    <footer class="plan-dialog-footer"><RouterLink v-if="deleted && canViewDeleted" class="button" :to="{ name: 'task-recycle', params: { projectId }, query: { task: taskId } }">查看删除记录</RouterLink><button v-if="error" class="button primary" :disabled="loading" @click="reload">重新读取任务</button><button v-if="previous" class="button" @click="backFromStatus">返回{{ previous.title }}</button></footer>
  </dialog>
</template>
