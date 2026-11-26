<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import type { ActivityPage, ActivitySummary } from '../../../../shared/src/activities';
import { fetchActivities } from '../../api/activities';
import { useProjectRefresh } from '../../stores/useProjectRefresh';
import { useAuthStore } from '../../stores/auth';
import ActivityRow from './ActivityRow.vue';
import './activities.css';
const props = defineProps<{ projectId: string; refreshKey: object }>();
const emit = defineEmits<{ open: [activity?: ActivitySummary] }>();
const page = ref<ActivityPage | null>(null), expanded = ref(false), loading = ref(false), error = ref(''), fresh = ref(false);
const refresh = useProjectRefresh();
const auth = useAuthStore();
let sequence = 0, probeSequence = 0, controller: AbortController | undefined, probe: AbortController | undefined;
async function load() {
  const seq = ++sequence; controller?.abort(); controller = new AbortController(); loading.value = true; error.value = '';
  try { const result = await fetchActivities(props.projectId,{limit:5,range:'7d'},controller.signal); if(seq===sequence){page.value=result;fresh.value=false;} }
  catch(e) { if(seq===sequence && (e as Error).name!=='AbortError') error.value = e instanceof Error ? e.message : '读取失败，请重试。'; }
  finally { if(seq===sequence) loading.value=false; }
}
watch(() => [props.projectId,props.refreshKey], () => { page.value=null;void load(); }, {immediate:true});
watch(refresh.revision, async () => {
  if(!page.value)return;
  const seq=++probeSequence; probe?.abort();probe=new AbortController();
  try { const result=await fetchActivities(props.projectId,{limit:1},probe.signal); if(seq===probeSequence && page.value)fresh.value=result.activityVersion!==page.value.activityVersion; } catch { /* Feed read failures use the explicit load/retry surface. */ }
});
onBeforeUnmount(()=>{sequence++;probeSequence++;controller?.abort();probe?.abort();});
</script>
<template>
  <section class="panel activity-panel pa-panel" aria-label="项目动态">
    <div class="panel-heading compact"><h2>项目动态 <span class="activity-live"></span></h2><div class="pa-panel-actions"><button class="text-button" :aria-expanded="expanded" @click="expanded=!expanded">{{ expanded?'收起':'展开' }}</button><button class="text-button" @click="emit('open')">查看全部</button></div></div>
    <div v-if="fresh" class="pa-update" role="status">有新动态<button class="text-button" :disabled="loading" @click="load">刷新动态</button></div>
    <p v-if="loading && !page" class="inline-empty" role="status">正在读取项目动态…</p>
    <div v-if="error" class="pa-error" role="alert">{{ error }}<button class="text-button" :disabled="loading" @click="load">重试动态</button></div>
    <p v-if="page?.backfill.status === 'pending' || page?.backfill.status === 'running'" class="pa-note">正在补录最近 7 天的完成记录，实时动态正常更新。</p>
    <p v-else-if="page?.backfill.status === 'failed'" class="pa-note">历史补录暂未完成，系统会重试。实时动态正常更新。</p>
    <p v-if="page && !page.items.length && !loading && !error" class="inline-empty">最近 7 天暂无关键进展。{{ auth.capabilities(projectId).risks ? '完成任务、调整计划或处理重要风险后' : '完成任务、调整计划或更新工作分组后' }}，会显示在这里。</p>
    <div v-if="page" class="pa-list"><ActivityRow v-for="activity in page.items.slice(0,expanded?5:2)" :key="activity.id" :activity="activity" @select="emit('open',$event)"/></div>
  </section>
</template>
