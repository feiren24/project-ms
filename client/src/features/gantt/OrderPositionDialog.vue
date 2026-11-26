<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { PlanOrderController } from './usePlanOrder';
import OrderDialog from './OrderDialog.vue';
const props = defineProps<{ order: PlanOrderController }>();
const query = ref(''), target = ref(''), placement = ref<'before'|'after'>('before'), limit = ref(50);
const byId = computed(() => new Map(props.order.nodes.map(node => [node.id, node])));
const candidates = computed(() => props.order.siblings.filter(id => id !== props.order.selectedId).flatMap(id => {
  const node = byId.value.get(id);
  return node && `${node.wbs} ${node.title}`.toLowerCase().includes(query.value.trim().toLowerCase()) ? [node] : [];
}));
const targetNode = computed(() => byId.value.get(target.value));
watch(query, () => { limit.value = 50; });
function apply() { if (!target.value || props.order.locked) return; props.order.move(props.order.selectedId, target.value, placement.value); props.order.positionOpen = false; }
</script>
<template>
  <OrderDialog title="移动到指定位置" @close="order.positionOpen = false">
    <p class="order-object">当前任务：<b>{{ order.selected?.wbs }} {{ order.selected?.title }}</b></p>
    <p class="plan-field-note">所属层级：{{ byId.get(order.selected?.parentId || '')?.title }}</p>
    <label class="order-search">目标任务<input v-model="query" placeholder="搜索同级任务名称或编号" type="search" /></label>
    <fieldset class="order-targets"><legend>选择目标任务（{{ candidates.length }} 项）</legend>
      <label v-for="node in candidates.slice(0,limit)" :key="node.id"><input v-model="target" type="radio" name="order-target" :value="node.id" /><span>{{ node.wbs }} {{ node.title }}<small v-if="node.kind === 'group'"> · 汇总任务</small><small v-if="node.kind === 'milestone'"> · 里程碑</small></span></label>
      <p v-if="!candidates.length" class="plan-field-note">没有匹配的同级任务，请修改搜索内容。</p>
      <button v-if="candidates.length > limit" class="button" @click="limit += 50">加载更多同级任务</button>
    </fieldset>
    <fieldset class="order-placement"><legend>放置位置</legend><label><input v-model="placement" type="radio" value="before" name="order-placement" />目标之前</label><label><input v-model="placement" type="radio" value="after" name="order-placement" />目标之后</label></fieldset>
    <p v-if="targetNode" class="plan-callout">将“{{ order.selected?.title }}”放在“{{ targetNode.title }}”{{ placement === 'before' ? '之前' : '之后' }}。</p>
    <p class="plan-field-note">将更新页面预览，保存顺序后对当前项目成员生效。</p>
    <template #footer><button class="button" @click="order.positionOpen = false">取消</button><button class="button primary" :disabled="!targetNode || order.locked" @click="apply">应用到预览</button></template>
  </OrderDialog>
</template>
