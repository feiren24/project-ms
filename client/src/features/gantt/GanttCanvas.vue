<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue';
import type { PlanBaseline, PlanDependency, PlanNode } from '../../../../shared/src/planning';
import Icon from '../../components/Icon.vue';
import PlanTreeLines from './PlanTreeLines.vue';
import type { PlanTreeMeta } from './plan-tree';
import { barGeometry, dateRange, daysBetween, dependencyPath, draftDates, isWeekend, monthSegments, PIXELS_PER_DAY, ROW_HEIGHT, weekSegments, type TimelineZoom } from './timeline';
import './gantt-canvas.css';
import './plan-tree.css';

const props = defineProps<{
  fill?: boolean; readOnly?: boolean; ordering?: boolean; orderLocked?: boolean; rows: PlanNode[]; tree: Map<string, PlanTreeMeta>; dependencies: PlanDependency[]; baseline: PlanBaseline | null;
  criticalIds: string[]; showCritical: boolean; zoom: TimelineZoom; fit?: boolean;
  rangeStart: string; rangeEnd: string; snapshotDate: string; isDemo: boolean;
  collapsedIds: string[]; selectedId: string | null;
}>();
const emit = defineEmits<{
  select: [node: PlanNode]; toggle: [id: string];
  reorder: [change: { id: string; targetId: string; placement: 'before' | 'after' }];
  reschedule: [change: { taskId: string; start: string; end: string }];
  viewport: [position: { scrollLeft: number; scrollTop: number }];
}>();
const viewport = ref<HTMLDivElement | null>(null);
const markerId = `dependency-arrow-${useId().replace(/:/g, '')}`;
const viewportWidth = ref(0), labelWidth = ref(384), viewportHeight = ref(560), scrollTop = ref(0), focusedId = ref<string | null>(null);
const windowStart = computed(() => Math.max(0, Math.min(Math.floor(scrollTop.value / ROW_HEIGHT) - 6, Math.max(0, props.rows.length - 1))));
const windowEnd = computed(() => Math.min(props.rows.length, windowStart.value + Math.ceil(viewportHeight.value / ROW_HEIGHT) + 12));
const renderedRows = computed(() => {
  const indices = new Set(Array.from({ length: Math.max(0, windowEnd.value - windowStart.value) }, (_, offset) => windowStart.value + offset));
  for (const id of [drag.value?.node.id, orderDrag.value?.node.id, focusedId.value]) { const index = id ? rowIndex.value.get(id) : undefined; if (index !== undefined) indices.add(index); }
  return [...indices].sort((a,b) => a-b).map(index => ({ node: props.rows[index]!, index }));
});
const orderDrag = ref<{ node: PlanNode; pointerId: number; element: HTMLElement; originY: number; x: number; y: number; moved: boolean } | null>(null);
const orderDrop = ref<{ targetId: string; placement: 'before'|'after'; line: number; title: string } | null>(null);
let orderFrame = 0;
function startOrderDrag(event: PointerEvent, node: PlanNode) {
  if (!props.ordering || props.orderLocked || !node.parentId || event.button !== 0) return;
  event.preventDefault();
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  orderDrag.value = { node, pointerId: event.pointerId, element, originY: event.clientY, x: event.clientX, y: event.clientY, moved: false };
  emit('select', node);
  orderFrame = requestAnimationFrame(scrollOrderDrag);
}
function calculateOrderDrop() {
  const current = orderDrag.value, container = viewport.value;
  orderDrop.value = null;
  if (!current?.moved || !container) return;
  const rect = container.getBoundingClientRect();
  if (current.y < rect.top + 64 || current.y > rect.bottom || current.x < rect.left || current.x > rect.right) return;
  const y = current.y - rect.top + container.scrollTop - 64;
  const index = Math.floor(y / ROW_HEIGHT), target = props.rows[index];
  if (!target || target.id === current.node.id || target.parentId !== current.node.parentId) return;
  const placement = y % ROW_HEIGHT < ROW_HEIGHT / 2 ? 'before' : 'after';
  let line = index + (placement === 'after' ? 1 : 0);
  if (placement === 'after') {
    const descendants = new Set([target.id]);
    while (line < props.rows.length && props.rows[line]!.parentId && descendants.has(props.rows[line]!.parentId!)) { descendants.add(props.rows[line]!.id); line++; }
  }
  orderDrop.value = { targetId: target.id, placement, line: line * ROW_HEIGHT, title: `放在「${target.title}」${placement === 'before' ? '之前' : '之后'}` };
}
function scrollOrderDrag() {
  const current = orderDrag.value, container = viewport.value;
  if (!current || !container) return;
  if (current.moved) {
    const rect = container.getBoundingClientRect();
    container.scrollTop += current.y < rect.top + 96 ? -10 : current.y > rect.bottom - 32 ? 10 : 0;
    reportViewport(); calculateOrderDrop();
  }
  orderFrame = requestAnimationFrame(scrollOrderDrag);
}
function moveOrderDrag(event: PointerEvent) {
  const current = orderDrag.value;
  if (!current || event.pointerId !== current.pointerId) return;
  current.x = event.clientX; current.y = event.clientY;
  if (Math.abs(current.y - current.originY) > 4) current.moved = true;
  calculateOrderDrop();
}
function cancelOrderDrag() {
  cancelAnimationFrame(orderFrame);
  const current = orderDrag.value;
  if (current?.moved) suppressClickUntil = performance.now() + 350;
  orderDrag.value = null; orderDrop.value = null;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
}
function finishOrderDrag(event: PointerEvent) {
  const current = orderDrag.value;
  if (!current || current.pointerId !== event.pointerId) return;
  const target = orderDrop.value;
  cancelOrderDrag();
  if (target && !props.orderLocked) emit('reorder', { id: current.node.id, targetId: target.targetId, placement: target.placement });
}
watch(() => [props.ordering, props.orderLocked], () => { if (!props.ordering || props.orderLocked) cancelOrderDrag(); });
let resizeObserver: ResizeObserver | undefined;
const pixels = computed(() => props.fit && viewportWidth.value > 700 ? Math.max(2, (viewportWidth.value - labelWidth.value - 2) / dateRange(props.rangeStart, props.rangeEnd).length) : PIXELS_PER_DAY[props.zoom]);
const days = computed(() => dateRange(props.rangeStart, props.rangeEnd));
const width = computed(() => days.value.length * pixels.value);
const months = computed(() => monthSegments(props.rangeStart, props.rangeEnd));
const weeks = computed(() => weekSegments(props.rangeStart, props.rangeEnd));
const critical = computed(() => new Set(props.showCritical ? props.criticalIds : []));
const baselines = computed(() => new Map(props.baseline?.entries.map(entry => [entry.taskId, entry]) ?? []));
const snapshotX = computed(() => (daysBetween(props.rangeStart, props.snapshotDate) + .5) * pixels.value);
const hasSnapshot = computed(() => snapshotX.value >= 0 && snapshotX.value < width.value);
const statusLabels = { todo: '待办', in_progress: '进行中', done: '已完成', review: '待验收' };
const rowIndex = computed(() => new Map(props.rows.map((row, index) => [row.id, index])));
const drawableEdges = computed(() => props.dependencies.flatMap(edge => {
  const sourceIndex = rowIndex.value.get(edge.predecessorId);
  const targetIndex = rowIndex.value.get(edge.successorId);
  if (sourceIndex === undefined || targetIndex === undefined) return [];
  const source = props.rows[sourceIndex]!;
  const target = props.rows[targetIndex]!;
  if (!source.start || !source.end || !target.start || !target.end) return [];
  const a = geometry(source); const b = geometry(target);
  return [{ ...edge, sourceIndex, targetIndex, path: dependencyPath(a.left + a.width, sourceIndex, b.left, targetIndex), title: `${source.title} → ${target.title}（完成后开始，间隔 ${edge.lagDays} 个工作日）` }];
}));
const visibleEdges = computed(() => drawableEdges.value.filter(edge => Math.max(edge.sourceIndex, edge.targetIndex) >= windowStart.value - 1 && Math.min(edge.sourceIndex, edge.targetIndex) < windowEnd.value + 1));
const hiddenEdges = computed(() => props.dependencies.length - drawableEdges.value.length);
const drag = ref<{ node: PlanNode; mode: 'move' | 'resize'; pointerId: number; originX: number; originScroll: number; offset: number; moved: boolean; element: HTMLElement } | null>(null);
let suppressClickUntil = 0, dragFrame = 0, pointerX = 0, pointerY = 0;
function geometry(node: PlanNode) {
  return node.start && node.end ? barGeometry(node.start, node.end, props.rangeStart, pixels.value) : { left: 0, width: 0 };
}
function barStyle(node: PlanNode) {
  const rect = geometry(node);
  return { left: `${rect.left}px`, width: `${Math.max(node.kind === 'milestone' ? 18 : 8, node.kind === 'milestone' ? pixels.value : rect.width)}px`, '--workstream-color': color(node), '--progress': `${progress(node)}%` };
}
const progress = (node: PlanNode) => Math.max(0, Math.min(100, node.progress));
function color(node: PlanNode): string {
  const names: Record<string, string> = { blue: 'var(--primary)', purple: 'var(--violet)', violet: 'var(--violet)', cyan: 'var(--cyan)', green: 'var(--green)', orange: 'var(--orange)', slate: 'var(--slate)' };
  return names[node.color] ?? (/^#[\da-f]{3,8}$/i.test(node.color) ? node.color : 'var(--primary)');
}
function baselineStyle(node: PlanNode) {
  const entry = baselines.value.get(node.id);
  if (!entry?.start || !entry.end) return undefined;
  const rect = barGeometry(entry.start, entry.end, props.rangeStart, pixels.value);
  return { left: `${rect.left}px`, width: `${rect.width}px` };
}
const treeMeta = (id: string) => props.tree.get(id)!;
function title(node: PlanNode) { return `${treeMeta(node.id).path} · ${treeMeta(node.id).caption} · ${node.wbs} ${node.title} · ${node.owner || '未分配'} · ${statusLabels[node.status]}${node.kind !== 'milestone' ? ` · 完成进度 ${progress(node)}%` : ''} · ${node.start && node.end ? `${node.start} 至 ${node.end}` : '待排期'}${critical.value.has(node.id) ? ' · 关键路径' : ''}。${props.ordering ? '点击选择任务以调整同级顺序。' : '点击查看详情或用日期表单调整。'}`; }
function select(node: PlanNode) { if (performance.now() >= suppressClickUntil) emit('select', node); }
function editable(node: PlanNode) { return !props.ordering && !props.readOnly && node.kind === 'task' && ['todo', 'in_progress'].includes(node.status) && !!node.start && !!node.end; }
function startDrag(event: PointerEvent, node: PlanNode, mode: 'move' | 'resize') {
  if (!editable(node) || event.button !== 0 || event.pointerType === 'touch') return;
  const element = event.currentTarget as HTMLElement;
  element.setPointerCapture(event.pointerId);
  pointerX = event.clientX; pointerY = event.clientY;
  drag.value = { node, mode, pointerId: event.pointerId, originX: event.clientX, originScroll: viewport.value?.scrollLeft ?? 0, offset: 0, moved: false, element };
  dragFrame = requestAnimationFrame(autoScrollDrag);
}
function autoScrollDrag() {
  const container = viewport.value, current = drag.value;
  if (!container || !current) return;
  if (current.moved) {
    const rect = container.getBoundingClientRect();
    const velocity = (position:number,start:number,end:number) => position < start + 32 ? -12 : position > end - 32 ? 12 : 0;
    container.scrollLeft += velocity(pointerX,rect.left+labelWidth.value,rect.right);
    container.scrollTop += velocity(pointerY,rect.top+64,rect.bottom);
    current.offset = Math.round((pointerX-current.originX+container.scrollLeft-current.originScroll)/pixels.value);
    reportViewport();
  }
  dragFrame = requestAnimationFrame(autoScrollDrag);
}
function moveDrag(event: PointerEvent) {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return;
  pointerX = event.clientX; pointerY = event.clientY;
  const delta = event.clientX - drag.value.originX + (viewport.value?.scrollLeft ?? 0) - drag.value.originScroll;
  if (Math.abs(delta) > 4) drag.value.moved = true;
  drag.value.offset = Math.round(delta / pixels.value);
}
const ghost = computed(() => {
  if (!drag.value?.moved) return null;
  const { node, offset, mode } = drag.value;
  const dates = draftDates(node.start!, node.end!, offset, mode);
  return { ...dates, taskId: node.id, geometry: barGeometry(dates.start, dates.end, props.rangeStart, pixels.value) };
});
function finishDrag(event: PointerEvent) {
  if (!drag.value || drag.value.pointerId !== event.pointerId) return;
  const change = ghost.value;
  const changed = change && (change.start !== drag.value.node.start || change.end !== drag.value.node.end);
  if (drag.value.moved) suppressClickUntil = performance.now() + 350;
  releaseDrag();
  if (changed && change) emit('reschedule', { taskId: change.taskId, start: change.start, end: change.end });
}
function releaseDrag() {
  cancelAnimationFrame(dragFrame);
  const current = drag.value;
  drag.value = null;
  if (current?.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId);
}
function cancelDrag() { if (drag.value?.moved) suppressClickUntil = performance.now() + 350; releaseDrag(); }
async function handleKey(event: KeyboardEvent) {
  if (event.key === 'Escape') { cancelDrag(); cancelOrderDrag(); return; }
  if (!viewport.value?.contains(event.target as Node) || !props.rows.length || !['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(event.key)) return;
  event.preventDefault();
  const current = rowIndex.value.get(focusedId.value ?? '') ?? Math.floor(scrollTop.value / ROW_HEIGHT);
  const step = Math.max(1, Math.floor((viewportHeight.value - 64) / ROW_HEIGHT));
  const index = Math.max(0, Math.min(props.rows.length - 1, event.key === 'Home' ? 0 : event.key === 'End' ? props.rows.length - 1 : current + (event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : event.key === 'PageDown' ? step : -step)));
  focusedId.value = props.rows[index]!.id;
  viewport.value.scrollTop = index * ROW_HEIGHT; reportViewport();
  await nextTick(); viewport.value?.querySelector<HTMLButtonElement>(`[data-row-index="${index}"] .gantt-name-button`)?.focus({ preventScroll: true });
}
function locateDate(date: string) {
  if (!viewport.value) return;
  const labelWidth = parseFloat(getComputedStyle(viewport.value).getPropertyValue('--gantt-label-width')) || 384;
  viewport.value.scrollTo({ left: Math.max(0, daysBetween(props.rangeStart, date) * pixels.value - (viewport.value.clientWidth - labelWidth) / 3), behavior: 'smooth' });
}
function resetScroll() { viewport.value?.scrollTo({ left: 0, top: 0, behavior: 'smooth' }); }
function reportViewport() { if (viewport.value) { scrollTop.value = viewport.value.scrollTop; emit('viewport', { scrollLeft: viewport.value.scrollLeft, scrollTop: viewport.value.scrollTop }); } }
watch(() => props.rows, () => { if (focusedId.value && !rowIndex.value.has(focusedId.value)) focusedId.value = null; nextTick(reportViewport); });
function locateRow(id: string) {
  const index = rowIndex.value.get(id), container = viewport.value;
  if (index === undefined || !container) return;
  const top = index * ROW_HEIGHT;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (top + ROW_HEIGHT > container.scrollTop + container.clientHeight - 64) container.scrollTop = top + ROW_HEIGHT - container.clientHeight + 64;
  reportViewport();
}
defineExpose({ locateDate, resetScroll, locateRow });
onMounted(() => { window.addEventListener('keydown', handleKey); resizeObserver = new ResizeObserver(() => { if (viewport.value) { viewportWidth.value = viewport.value.clientWidth; viewportHeight.value = viewport.value.clientHeight; reportViewport(); labelWidth.value = parseFloat(getComputedStyle(viewport.value).getPropertyValue('--gantt-label-width')) || 384; } }); if (viewport.value) resizeObserver.observe(viewport.value); });
onBeforeUnmount(() => { resizeObserver?.disconnect(); window.removeEventListener('keydown', handleKey); releaseDrag(); cancelOrderDrag(); });
</script>

<template>
  <section class="gantt-canvas" aria-label="完整计划甘特图">
    <div ref="viewport" class="gantt-viewport" :style="fill ? undefined : { height: `min(var(--gantt-height, 560px), ${Math.max(1, rows.length) * ROW_HEIGHT + 66}px)` }" tabindex="0" aria-label="甘特时间轴，可横向和纵向滚动；选择任务可使用日期表单调整" @scroll="reportViewport">
      <div class="gantt-sheet" :style="{ '--timeline-width': `${width}px`, '--day-width': `${pixels}px` }">
        <div class="gantt-axis">
          <div class="gantt-label-header"><span>WBS / 任务名称</span><span class="gantt-owner">负责人</span><span class="gantt-status">状态</span></div>
          <div class="gantt-axis-time">
            <div class="gantt-months"><div v-for="month in months" :key="month.date" :style="{ width: `${month.days * pixels}px` }">{{ month.label }}</div></div>
            <div v-if="zoom === 'day'" class="gantt-ticks"><span v-for="date in days" :key="date" :class="{ weekend: isWeekend(date) }" :style="{ width: `${pixels}px` }">{{ Number(date.slice(8)) }}</span></div>
            <div v-else class="gantt-ticks"><span v-for="week in weeks" :key="week.date" :style="{ width: `${week.days * pixels}px` }">{{ week.days >= 3 ? week.label : '' }}</span></div>
          </div>
        </div>
        <div class="gantt-body" :style="{ height: `${Math.max(1, rows.length) * ROW_HEIGHT}px` }">
          <div class="gantt-background" aria-hidden="true"><span v-for="(date, index) in days" v-show="isWeekend(date)" :key="date" :style="{ left: `${index * pixels}px`, width: `${pixels}px` }"></span></div>
          <div v-for="{ node, index } in renderedRows" :key="node.id" class="gantt-row" :data-row-index="index" :data-node-id="node.id" :data-tree-depth="treeMeta(node.id).depth" :style="{ position: 'absolute', top: `${index * ROW_HEIGHT}px`, left: 0, right: 0 }" @focusin="focusedId = node.id" @focusout="focusedId = null" :class="{ 'is-group': node.kind === 'group', 'is-parent': treeMeta(node.id).isParent, 'is-subtree-end': treeMeta(node.id).subtreeEnd, 'is-context-only': treeMeta(node.id).contextOnly, 'is-selected': node.id === selectedId }">
            <div class="gantt-label-cell" :style="{ '--depth': Math.min(3, treeMeta(node.id).depth) }">
              <div class="gantt-task-name">
                <PlanTreeLines :meta="treeMeta(node.id)" />
                <button v-if="ordering && node.parentId" class="gantt-order-handle" :disabled="orderLocked" :aria-label="`拖动调整${node.title}顺序`" @click.stop="select(node)" @pointerdown="startOrderDrag($event,node)" @pointermove="moveOrderDrag" @pointerup="finishOrderDrag" @pointercancel="cancelOrderDrag" @lostpointercapture="cancelOrderDrag">⠿</button>
                <button v-if="node.kind === 'group'" class="gantt-toggle" :aria-label="`${collapsedIds.includes(node.id) ? '展开' : '收起'}${node.title}`" :aria-expanded="!collapsedIds.includes(node.id)" @click="emit('toggle', node.id)"><Icon :name="collapsedIds.includes(node.id) ? 'chevron' : 'down'" :size="14" /></button>
                <span v-else class="gantt-kind" aria-hidden="true">{{ node.kind === 'milestone' ? '◇' : '' }}</span>
                <button class="gantt-name-button" :title="title(node)" :aria-label="title(node)" @click="select(node)"><span class="gantt-name-copy"><span class="gantt-name-main"><span class="gantt-name">{{ node.title }}</span></span><span class="gantt-name-meta"><template v-if="treeMeta(node.id).caption">{{ treeMeta(node.id).caption }}</template><span v-else class="gantt-wbs">{{ node.wbs }}</span></span></span><span v-if="ordering && node.id === selectedId" class="gantt-order-selected">已选中</span><span v-if="node.kind !== 'milestone'" class="gantt-progress-label" :aria-label="`完成进度 ${progress(node)}%`">{{ progress(node) }}%</span></button>
              </div>
              <span class="gantt-owner" :title="node.owner">{{ node.owner || '未分配' }}</span>
              <span class="gantt-status" :class="`status-${node.status}`">{{ statusLabels[node.status] }}</span>
            </div>
            <div class="gantt-time-cell">
              <span v-if="baselineStyle(node)" class="gantt-baseline" :style="baselineStyle(node)" :title="`基线：${baselines.get(node.id)?.start} 至 ${baselines.get(node.id)?.end}`"></span>
              <button v-if="node.start && node.end" class="gantt-bar" :class="{ 'is-summary': node.kind === 'group', 'is-milestone': node.kind === 'milestone', 'is-critical': critical.has(node.id), 'is-editable': editable(node), 'is-done': node.status === 'done', 'has-progress': progress(node) > 0, 'is-progress-complete': progress(node) === 100 }" :style="barStyle(node)" :title="title(node)" :aria-label="title(node)" @click="select(node)" @pointerdown="startDrag($event, node, 'move')" @pointermove="moveDrag" @pointerup="finishDrag" @pointercancel="cancelDrag" @lostpointercapture="cancelDrag">
                <template v-if="node.kind !== 'milestone'">
                  <span class="gantt-progress" aria-hidden="true"></span>
                  <span v-if="progress(node) > 0 && progress(node) < 100" class="gantt-progress-divider" aria-hidden="true"></span>
                  <span v-if="node.kind !== 'group'" class="gantt-bar-caption" aria-hidden="true">{{ critical.has(node.id) ? '! ' : '' }}{{ node.title }}</span>
                  <span v-if="node.kind !== 'group'" class="gantt-bar-caption gantt-bar-caption-completed" aria-hidden="true">{{ critical.has(node.id) ? '! ' : '' }}{{ node.title }}</span>
                </template>
                <span v-if="editable(node)" class="gantt-resize" aria-hidden="true" @pointerdown.stop="startDrag($event, node, 'resize')">⋮</span>
              </button>
              <button v-else class="gantt-unscheduled" @click="select(node)">待排期 <Icon name="chevron" :size="12" /></button>
              <div v-if="ghost?.taskId === node.id" class="gantt-ghost" :style="{ left: `${ghost.geometry.left}px`, width: `${ghost.geometry.width}px` }"><span>{{ ghost.start.slice(5) }} → {{ ghost.end.slice(5) }} · 释放预览</span></div>
            </div>
          </div>
          <div v-if="orderDrop" class="gantt-order-line" :style="{ top: `${orderDrop.line}px` }"><span>{{ orderDrop.title }}</span></div>
          <svg class="gantt-dependencies" :width="width" :height="Math.max(1, windowEnd - windowStart) * ROW_HEIGHT" :style="{ top: `${windowStart * ROW_HEIGHT}px` }" :viewBox="`0 ${windowStart * ROW_HEIGHT} ${width} ${Math.max(1, windowEnd - windowStart) * ROW_HEIGHT}`" aria-label="可见任务依赖关系" role="img">
            <defs><marker :id="markerId" markerWidth="5" markerHeight="5" refX="4" refY="2.5" orient="auto"><path d="M0 0 L5 2.5 L0 5" fill="currentColor" /></marker></defs>
            <path v-for="edge in visibleEdges" :key="`${edge.predecessorId}-${edge.successorId}`" :d="edge.path" :marker-end="`url(#${markerId})`"><title>{{ edge.title }}</title></path>
          </svg>
          <div v-if="hasSnapshot" class="gantt-snapshot" :style="{ left: `calc(var(--gantt-label-width) + ${snapshotX}px)` }" aria-hidden="true"><span>{{ isDemo ? '示例快照' : '统计基准日' }} {{ snapshotDate.slice(5) }}</span></div>
          <div v-if="!rows.length" class="gantt-empty">没有符合筛选条件的任务，请调整筛选条件。</div>
        </div>
      </div>
      <div v-if="orderDrag?.moved" class="gantt-order-help" role="status">正在移动：{{ orderDrag.node.title }} · {{ orderDrop ? orderDrop.title : '只能移动到同一父级内' }} · Esc 取消本次拖动</div>
    </div>
    <div v-if="!fill" class="gantt-legend" aria-label="甘特图图例"><span><i class="legend-completed" aria-hidden="true"></i>已完成进度</span><span><i class="legend-remaining" aria-hidden="true"></i>剩余进度</span><span><i class="legend-milestone"></i>里程碑</span><span v-if="baseline"><i class="legend-baseline"></i>对比基线</span><span v-if="showCritical" class="gantt-critical-key">! 关键路径</span><span v-if="hiddenEdges" class="gantt-hidden-edges">{{ hiddenEdges }} 条依赖端点被筛选、折叠或待排期，仍参与计算</span><span class="gantt-drag-help">{{ ordering ? '选择任务后可用上移、下移或指定位置；拖动手柄预览顺序' : '点击任务查看详情 · 拖动后预览变更' }}</span></div>
  </section>
</template>
