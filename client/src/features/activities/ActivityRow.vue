<script setup lang="ts">
import type { ActivitySummary } from '../../../../shared/src/activities';
import { activityTime } from './presentation';
defineProps<{ activity: ActivitySummary }>();
const emit = defineEmits<{ select: [activity: ActivitySummary] }>();
</script>
<template>
  <button class="pa-row" :data-activity-id="activity.id" @click="emit('select', activity)">
    <span class="avatar small-avatar" aria-hidden="true">{{ activity.actor.name.slice(0,1) }}</span>
    <span class="pa-copy"><span class="pa-summary"><b>{{ activity.actor.name }}</b> {{ activity.summary }}</span>
      <span v-if="activity.count > 1 || !activity.summary.includes(activity.preview[0] || '')" class="pa-preview">{{ activity.preview.join('、') }}{{ activity.count > activity.preview.length ? ' …' : '' }}</span>
      <span class="pa-meta"><time :datetime="activity.occurredAt">{{ activityTime(activity.occurredAt, activity.lastOccurredAt) }}</time><span v-if="activity.historical" class="pa-history">历史补录</span><span v-if="activity.count > 1" class="pa-link">查看 {{ activity.count }} 项</span></span>
    </span><span class="pa-chevron" aria-hidden="true">›</span>
  </button>
</template>
