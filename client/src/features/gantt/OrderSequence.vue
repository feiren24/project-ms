<script setup lang="ts">
import { computed, ref } from 'vue';
import type { PlanNode } from '../../../../shared/src/planning';
const props = defineProps<{ ids: string[]; nodes: PlanNode[] }>();
const limit = ref(50), byId = computed(() => new Map(props.nodes.map(node => [node.id, node])));
</script>
<template>
  <ol class="order-sequence"><li v-for="id in ids.slice(0,limit)" :key="id">{{ byId.get(id)?.wbs }} {{ byId.get(id)?.title || '已移除的计划项' }}</li></ol>
  <p v-if="!ids.length" class="plan-field-note">此层级已无可见计划项。</p>
  <button v-if="ids.length > limit" class="plan-text-button" @click="limit += 50">继续查看（{{ limit }} / {{ ids.length }}）</button>
</template>
