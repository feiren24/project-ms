<script setup lang="ts">
import type { PlanIssue, PlanNode } from '../../../../shared/src/planning';
defineProps<{ gaps: PlanNode[]; issues: PlanIssue[]; nodes: PlanNode[] }>();
defineEmits<{ select: [node: PlanNode] }>();
</script>
<template>
  <div class="plan-attention-body"><p class="plan-description">检查覆盖依赖、工作日、范围缺口和每周人员投入。超负荷只提示，不会自动调整人员。</p><button v-for="gap in gaps" :key="gap.id" class="plan-gap-item" @click="$emit('select', gap)"><span class="orange-text">待排期</span><b>{{ gap.title }}</b><span>›</span></button><div v-for="issue in issues" :key="issue.id" class="plan-issue" :class="issue.severity"><b>{{ issue.title }}</b><p>{{ issue.description }}</p><button v-if="nodes.some(n => n.id === issue.objectId)" class="plan-text-button" @click="$emit('select', nodes.find(n => n.id === issue.objectId)!)">查看关联计划项</button></div><p v-if="!issues.length && !gaps.length" class="plan-description">当前计划通过完整性检查。</p></div>
</template>
