<script setup lang="ts">
import type { PersonnelMetric } from '../../../../shared/src/analytics';
import { formatPersonnelRate } from './personnel';
defineProps<{ metric: PersonnelMetric; label: string; detailed?: boolean }>();
defineEmits<{ select: [part: 'numerator' | 'denominator' | 'missing'] }>();
</script>
<template>
  <div class="personnel-rate">
    <button class="analytics-link personnel-rate-main" :aria-label="`${label} ${formatPersonnelRate(metric.value)}，查看分子 ${metric.numerator} 项任务`" @click="$emit('select', 'numerator')">
      <strong :class="{ 'personnel-unknown': metric.value === null }">{{ formatPersonnelRate(metric.value) }}</strong>
      <small>{{ metric.numerator }} / {{ metric.denominator }} 项</small>
    </button>
    <template v-if="detailed">
      <p>{{ metric.description }}</p>
      <div class="personnel-metric-links">
        <button class="analytics-link" @click="$emit('select', 'numerator')">分子 {{ metric.numerator }} 项</button>
        <button class="analytics-link" @click="$emit('select', 'denominator')">分母 {{ metric.denominator }} 项</button>
        <button class="analytics-link" @click="$emit('select', 'missing')">缺失 {{ metric.missing }} 项</button>
      </div>
    </template>
  </div>
</template>
