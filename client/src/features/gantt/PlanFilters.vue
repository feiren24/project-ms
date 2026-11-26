<script setup lang="ts">
import type { PlanBaseline, PlanNode } from '../../../../shared/src/planning';
defineProps<{ view: {workstream: string; owner: string; status: string; baselineId: string}; groups: PlanNode[]; owners: string[]; baselines: PlanBaseline[] }>();
</script>
<template>
  <label class="plan-filter-field"><span>工作分组</span><select v-model="view.workstream" aria-label="筛选工作分组"><option value="">全部工作分组</option><option v-for="group in groups" :key="group.id" :value="group.workstreamId">{{ group.title }}</option></select></label>
  <label class="plan-filter-field"><span>负责人</span><select v-model="view.owner" aria-label="筛选负责人"><option value="">全部负责人</option><option v-for="owner in owners" :key="owner">{{ owner }}</option></select></label>
  <label class="plan-filter-field"><span>状态</span><select v-model="view.status" aria-label="筛选状态"><option value="">全部状态</option><option value="todo">待办</option><option value="in_progress">进行中</option><option value="done">已完成</option><option value="review">待验收</option></select></label>
  <label class="plan-filter-field plan-filter-baseline"><span>对比基线</span><select v-model="view.baselineId" aria-label="对比基线"><option value="">不显示基线</option><option v-for="item in baselines" :key="item.id" :value="item.id">{{ item.name }}</option></select></label>
</template>
