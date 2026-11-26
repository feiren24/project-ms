<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref } from 'vue';
import { taskDateError, taskDatePreset, taskDateToday, type TaskDateFilter, type TaskDatePreset } from '../../../../shared/src/task-dates';
const props = defineProps<{ value: TaskDateFilter; isDemo: boolean; asOf: string }>();
const emit = defineEmits<{ close: []; apply: [value: TaskDateFilter]; clear: [] }>();
const draft = reactive({ ...props.value }), dialog = ref<HTMLDialogElement>();
const preset = ref('custom'), validation = computed(() => taskDateError(draft));
const base = props.isDemo ? props.asOf : taskDateToday();
const shortcuts: { id: TaskDatePreset; label: string }[] = [{ id: 'today', label: '今天' }, { id: 'week', label: '本周' }, { id: 'nextWeek', label: '下周' }, { id: 'month', label: '本月' }];
function choose(id: TaskDatePreset) { preset.value = id; Object.assign(draft, taskDatePreset(base, id)); }
function apply() { if (!validation.value) emit('apply', { ...draft }); }
let returnFocus: HTMLElement | null = null;
onMounted(() => { returnFocus = document.activeElement as HTMLElement; dialog.value?.showModal(); });
onBeforeUnmount(() => { dialog.value?.close(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
</script>
<template>
  <dialog ref="dialog" class="task-bulk-dialog task-date-dialog" aria-labelledby="task-date-title" @close="emit('close')">
    <header><h2 id="task-date-title">日期筛选</h2><button class="icon-button" aria-label="关闭日期筛选" @click="emit('close')">×</button></header>
    <form id="task-date-form" class="task-bulk-body" @submit.prevent="apply">
      <label>筛选依据<select v-model="draft.dateMode" autofocus><option value="overlap">计划周期</option><option value="due">计划截止日期</option></select></label>
      <div class="task-date-shortcuts" aria-label="快捷日期周期"><button v-for="item in shortcuts" :key="item.id" type="button" class="button" :aria-pressed="preset === item.id" @click="choose(item.id)">{{ item.label }}</button><button type="button" class="button" :aria-pressed="preset === 'custom'" @click="preset = 'custom'">自定义</button></div>
      <div class="task-date-fields"><label>开始日期<input v-model="draft.dateFrom" type="date" required aria-describedby="task-date-error" @input="preset = 'custom'" /></label><label>结束日期<input v-model="draft.dateTo" type="date" required aria-describedby="task-date-error" @input="preset = 'custom'" /></label></div>
      <p v-if="validation && (draft.dateFrom || draft.dateTo)" id="task-date-error" class="task-date-error" role="alert">{{ validation }}</p>
      <p class="task-date-help">{{ draft.dateMode === 'overlap' ? '计划执行时间与所选日期有重叠即显示。' : '显示计划截止日期位于所选范围内的任务。' }}包含起止当天；缺少完整排期的任务不计入。保留当前状态及其他筛选。</p>
      <p class="task-date-help">{{ isDemo ? 'DEMO · 快捷周期按示例快照日' : '快捷周期按北京时间' }} {{ base }} 计算，本周为周一至周日。</p>
    </form>
    <footer><button class="button task-date-clear" @click="emit('clear')">清除日期</button><button class="button" @click="emit('close')">取消</button><button class="button primary" form="task-date-form" :disabled="!!validation">应用筛选</button></footer>
  </dialog>
</template>
