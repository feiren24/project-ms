<script setup lang="ts">
import { computed } from 'vue';
import { RouterLink } from 'vue-router';
import type { PlanOrderController } from './usePlanOrder';
import OrderDialog from './OrderDialog.vue';
import OrderPositionDialog from './OrderPositionDialog.vue';
import OrderSequence from './OrderSequence.vue';
import './plan-order.css';
const props = defineProps<{ order: PlanOrderController; scopeName: string; compact?: boolean }>();
defineEmits<{ expand: [] }>();
const byId = computed(() => new Map(props.order.nodes.map(node => [node.id,node])));
const comparison = computed(() => props.order.changes.map(group => ({ ...group,
  title: byId.value.get(group.parentId)?.title ?? '原所属层级',
  latestIds: props.order.latest?.siblingOrders.find(item => item.parentId === group.parentId)?.nodeIds ?? [],
})));
</script>
<template>
  <div v-if="order.active" class="plan-order-controls" :class="{ 'order-compact': compact }" aria-label="任务顺序调整">
    <div class="order-mode-heading"><div><h3>调整任务顺序</h3><p>同级移动 · 全项目共享 · 原任务编号保留</p></div>
      <div class="order-save-actions"><span role="status">{{ order.busy ? '正在处理…' : order.dirty ? '有未保存调整' : '尚未调整' }}</span><button class="button" :disabled="order.busy" @click="order.cancel">取消</button><button class="button primary" :disabled="!order.dirty || order.locked" @click="order.save">{{ order.busy ? '正在保存…' : '保存顺序' }}</button></div>
    </div>
    <div v-if="!compact" class="order-scope"><span>当前范围：{{ scopeName }}</span><div><button class="plan-text-button" :disabled="order.busy" @click="$emit('expand')">展开全部</button><RouterLink :to="{ name: 'workstreams' }" class="plan-text-button" :aria-disabled="order.busy" @click="order.busy && $event.preventDefault()">管理工作分组</RouterLink></div></div>
    <div v-if="compact" class="order-compact-scope"><button class="plan-text-button" :disabled="order.busy" @click="$emit('expand')">展开全部</button><RouterLink :to="{ name: 'workstreams' }" class="plan-text-button" :aria-disabled="order.busy" @click="order.busy && $event.preventDefault()">管理工作分组</RouterLink></div><div class="order-selection"><div><span>{{ order.selected ? '已选：' : '请选择任务，或拖动名称旁的手柄' }}</span><b v-if="order.selected">{{ order.selected.wbs }} {{ order.selected.title }}</b><small v-if="order.descendants">将连同 {{ order.descendants }} 项子任务一起移动</small></div><div class="order-selection-buttons"><button class="button" :disabled="!order.canUp" @click="order.step('up')">上移</button><button class="button" :disabled="!order.canDown" @click="order.step('down')">下移</button><button class="button" :disabled="!order.canPosition" @click="order.positionOpen = true">移动到...</button></div></div>
    <div v-if="order.error" class="order-error" role="alert"><b v-if="order.stale">项目顺序或同级任务已更新。 </b>{{ order.error }}<p>你的调整草稿已保留。</p><button v-if="order.stale || order.forbidden" class="button" :disabled="order.busy" @click="order.compare">查看最新顺序并对照</button><button v-else class="button" :disabled="order.locked" @click="order.save">重试保存</button></div>
    <details v-if="order.reference" class="order-reference"><summary>查看重新整理前的草稿（只读参考）</summary><div v-for="group in order.reference.orders" :key="group.parentId"><b>{{ order.reference.nodes.find(node => node.id === group.parentId)?.title }}</b><OrderSequence :ids="group.nodeIds" :nodes="order.reference.nodes" /></div></details>
  </div>
  <OrderDialog v-if="order.filterPrompt" title="显示完整同级任务" @close="order.filterPrompt = false"><p>调整顺序需要显示完整同级任务。将暂时清除搜索、负责人和状态筛选，退出后恢复；工作分组范围保持。</p><template #footer><button class="button" @click="order.filterPrompt = false">取消</button><button class="button primary" @click="order.begin">清除筛选并进入</button></template></OrderDialog>
  <OrderDialog v-if="order.discardPrompt" title="放弃未保存的顺序调整？" @close="order.discardPrompt = false"><p>将恢复已保存的任务顺序，本次尚未保存的移动会被放弃。</p><template #footer><button class="button" @click="order.finish">放弃调整</button><button class="button primary" autofocus @click="order.discardPrompt = false">继续编辑</button></template></OrderDialog>
  <OrderPositionDialog v-if="order.positionOpen" :order="order" />
  <OrderDialog v-if="order.compareOpen && order.latest" title="核对任务顺序" wide @close="order.compareOpen = false">
    <p class="plan-field-note">原草稿保留用于对照；以最新顺序重新整理后，需要再次保存。新增、取消或改变归属的任务以当前已保存结果为准。</p>
    <section v-for="group in comparison" :key="group.parentId" class="order-compare-group"><h3>{{ group.title }}</h3><div class="order-comparison"><div><h4>当前已保存</h4><OrderSequence :ids="group.latestIds" :nodes="order.latest.nodes" /></div><div><h4>我的未保存草稿</h4><OrderSequence :ids="group.nodeIds" :nodes="order.nodes" /></div></div></section>
    <template #footer><button class="button" @click="order.compareOpen = false">返回草稿</button><button class="button primary" :disabled="order.forbidden && order.locked" @click="order.restart">以最新顺序重新整理</button></template>
  </OrderDialog>
</template>
