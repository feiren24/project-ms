<script setup lang="ts">
import { computed } from 'vue';
import type { PlanTreeMeta } from './plan-tree';
defineOptions({ inheritAttrs: false });
const props = defineProps<{ meta: PlanTreeMeta }>();
// Deep legacy trees retain the nearest ancestors; the full path remains in the row's text alternative.
const guides = computed(() => props.meta.guides.slice(-2));
</script>

<template>
  <span class="plan-tree-lines" aria-hidden="true">
    <i v-for="(continues, index) in guides" :key="index" class="plan-tree-guide" :class="{ 'is-continuing': continues }" :style="{ '--level': index }"></i>
    <i v-if="meta.depth" class="plan-tree-branch" :class="{ 'is-last': meta.last }" :style="{ '--level': Math.min(meta.depth, 3) - 1 }"></i>
    <i v-if="meta.startsChildren" class="plan-tree-start" :style="{ '--level': Math.min(meta.depth, 3) }"></i>
  </span>
</template>
