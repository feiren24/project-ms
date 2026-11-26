<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useAuthStore } from '../../stores/auth';
import { visibleActivity } from '../../utils/module-privacy';
import { useRouter } from 'vue-router';
import type { ActivityPage, ActivitySummary, ActivityCategory, ActivityRange, ActivityItem, ActivityBackfill, ActivityTarget } from '../../../../shared/src/activities';
import { fetchActivities, fetchActivityItems } from '../../api/activities';
import { PlanningError } from '../../api/planning';
import { useProjectRefresh } from '../../stores/useProjectRefresh';
import { activityCategories, activityRoute, activityTime, activityField, activityValue } from './presentation';
import ActivityRow from './ActivityRow.vue';
import Icon from '../../components/Icon.vue';
import '../tasks/task-drawer.css';
import './activities.css';
const props=defineProps<{projectId:string;projectName:string;isDemo:boolean;initial?:ActivitySummary}>();
const emit=defineEmits<{close:[]}>();
const auth=useAuthStore();
const canViewRisks=computed(()=>auth.capabilities(props.projectId).risks);
const visibleCategories=computed(()=>activityCategories.filter(item=>visibleActivity(item.value,auth.capabilities(props.projectId))));
const router=useRouter(), refresh=useProjectRefresh();
const dialog=ref<HTMLDialogElement>(), body=ref<HTMLElement>();
const category=ref<ActivityCategory|'all'>('all'), range=ref<ActivityRange>('7d');
const page=ref<ActivityPage|null>(null), selected=ref<ActivitySummary|null>(props.initial||null), details=ref<ActivityItem[]>([]), detailsCursor=ref<string|null>(null);
const loading=ref(false), error=ref(''), notice=ref(''), fresh=ref(false), detailBackfill=ref<ActivityBackfill>();
const backfill=computed(()=>detailBackfill.value||page.value?.backfill);
let sequence=0, probeSequence=0, controller:AbortController|undefined, probe:AbortController|undefined, trigger:HTMLElement|null=null, savedScroll=0, failedMore=false, loadedVersion:number|undefined=props.initial?.snapshotVersion;
function failure(e:unknown) {
  error.value=e instanceof Error?e.message:'项目动态读取失败，请重试。';
  if(e instanceof PlanningError && ['ACTIVITY_CURSOR_INVALID','ACTIVITY_CURSOR_MISMATCH'].includes(e.code || '')) {
    // Cursor formats/permissions can change between deployments and page reads.
    // Discard every old cursor, including the selected summary's itemsCursor.
    page.value=null;selected.value=null;details.value=[];detailsCursor.value=null;detailBackfill.value=undefined;
    failedMore=false;loadedVersion=undefined;fresh.value=false;savedScroll=0;probeSequence++;probe?.abort();
    error.value='动态阅读位置已失效，请重试以重新读取最新动态。';
  }
  if(e instanceof PlanningError && [401,403].includes(e.status)){page.value=null;details.value=[];selected.value=null;}
}
async function load(more=false, preserveScroll=false) {
  const seq=++sequence, scroll=body.value?.scrollTop||0;controller?.abort();controller=new AbortController();loading.value=true;error.value='';notice.value='';failedMore=more;
  const revision=refresh.revision.value, previousDepth=page.value?.items.length||20;
  const bounds=body.value?.getBoundingClientRect();
  const anchor=preserveScroll ? Array.from(body.value?.querySelectorAll<HTMLElement>('[data-activity-id]')||[]).find(row=>row.getBoundingClientRect().bottom>(bounds?.top||0)) : undefined;
  const anchorId=anchor?.dataset.activityId, anchorOffset=anchor ? anchor.getBoundingClientRect().top-(bounds?.top||0) : 0;
  try {
    const query={category:category.value,range:range.value,limit:20};
    const result=await fetchActivities(props.projectId,{...query,...(more&&page.value?.nextCursor?{cursor:page.value.nextCursor}:{})},controller.signal);
    if(seq!==sequence)return;
    // Reload the previously opened depth under one new cursor snapshot. Keep the
    // first visible record as an anchor even when new groups precede it.
    while(preserveScroll && !more && result.nextCursor && (result.items.length<previousDepth || (anchorId && !result.items.some(row=>row.id===anchorId)))) {
      const next=await fetchActivities(props.projectId,{...query,cursor:result.nextCursor},controller.signal);
      if(seq!==sequence)return;
      result.items.push(...next.items);result.nextCursor=next.nextCursor;
    }
    page.value=more&&page.value?{...result,activityVersion:page.value.activityVersion,items:[...page.value.items,...result.items]}:result;
    if(!more)loadedVersion=result.items[0]?.snapshotVersion??result.activityVersion;
    fresh.value=result.activityVersion!==loadedVersion || (!more ? refresh.revision.value!==revision : fresh.value);
    await nextTick();
    if(body.value){
      const restored=anchorId?Array.from(body.value.querySelectorAll<HTMLElement>('[data-activity-id]')).find(row=>row.dataset.activityId===anchorId):undefined;
      body.value.scrollTop=more||preserveScroll?scroll:0;
      if(restored)body.value.scrollTop+=restored.getBoundingClientRect().top-body.value.getBoundingClientRect().top-anchorOffset;
    }
  } catch(e){if(seq===sequence && (e as Error).name!=='AbortError')failure(e);}
  finally{if(seq===sequence)loading.value=false;}
}
async function loadDetails(more=false) {
  if(!selected.value)return;
  const id=selected.value.id, seq=++sequence,scroll=body.value?.scrollTop||0;controller?.abort();controller=new AbortController();loading.value=true;error.value='';failedMore=more;
  try {
    const result=await fetchActivityItems(props.projectId,id,more?detailsCursor.value||undefined:selected.value.itemsCursor,controller.signal);
    if(seq!==sequence||selected.value?.id!==id)return;
    details.value=more?[...details.value,...result.items]:result.items;detailsCursor.value=result.nextCursor;detailBackfill.value=result.backfill;loadedVersion??=selected.value.snapshotVersion;fresh.value=fresh.value||result.activityVersion!==loadedVersion;
    await nextTick();if(body.value)body.value.scrollTop=more?scroll:0;
  }catch(e){if(seq===sequence && (e as Error).name!=='AbortError')failure(e);}
  finally{if(seq===sequence)loading.value=false;}
}
async function open(activity:ActivitySummary) {
  savedScroll=body.value?.scrollTop||0;selected.value=activity;details.value=[];detailsCursor.value=null;notice.value='';void loadDetails();
}
async function back() {
  sequence++;controller?.abort();loading.value=false;error.value='';notice.value='';selected.value=null;details.value=[];detailsCursor.value=null;detailBackfill.value=undefined;
  if(!page.value)await load();else {await nextTick();if(body.value)body.value.scrollTop=savedScroll;}
}
function navigate(target:ActivityTarget|null) {
  if(!target||target.available===false){notice.value='该对象已移除或当前无权访问，历史记录仍保留。';return;}
  const location=activityRoute(target,props.projectId);
  if(!location){notice.value='此记录保留历史信息，暂不支持直接打开对应对象。';return;}
  void router.push(location).then(failure=>{if(!failure)emit('close');});
}
function retry(){if(selected.value)void loadDetails(failedMore);else void load(failedMore,true);}
watch([category,range],()=>{page.value=null;void load();});
watch(refresh.revision,async()=>{
  if(loadedVersion===undefined)return;
  const seq=++probeSequence;probe?.abort();probe=new AbortController();
  try{const result=await fetchActivities(props.projectId,{limit:1},probe.signal);if(seq===probeSequence)fresh.value=result.activityVersion!==loadedVersion;}
  catch{ /* The next explicit reload owns error feedback. */ }
});
onMounted(()=>{trigger=document.activeElement as HTMLElement;dialog.value?.showModal();if(selected.value)void loadDetails();else void load();});
onBeforeUnmount(()=>{sequence++;probeSequence++;controller?.abort();probe?.abort();dialog.value?.close();trigger?.focus();});
</script>
<template>
<dialog ref="dialog" class="task-drawer pa-drawer" aria-labelledby="activity-drawer-title" @cancel.prevent="emit('close')" @click="event=>{if(event.target===dialog)emit('close');}">
 <div class="td-shell">
  <header class="td-header"><div class="td-header-row"><span class="td-reference">{{ projectName }}<span v-if="isDemo" class="demo-label">DEMO · 示例项目</span></span><button class="td-icon-button" aria-label="关闭项目动态" @click="emit('close')"><Icon name="close"/></button></div><h2 id="activity-drawer-title">{{ selected?'动态详情':'项目动态' }}</h2><p class="td-stream">{{ canViewRisks ? '完成成果、交付变化与重要风险。' : '完成成果、交付变化与工作分组协作。' }}日常编辑可在对应模块历史中查看。</p></header>
  <div v-if="!selected" class="pa-filters"><label>分类<select v-model="category" aria-label="动态分类"><option v-for="option in visibleCategories" :key="option.value" :value="option.value">{{ option.label }}</option></select></label><label>时间<select v-model="range" aria-label="动态时间范围"><option value="7d">最近 7 天</option><option value="30d">最近 30 天</option><option value="all">全部时间</option></select></label></div>
  <div v-if="fresh" class="pa-update" role="status"><span>有新动态，当前阅读内容已保留。</span><button class="text-button" :disabled="loading" @click="selected ? back().then(()=>load(false,true)) : load(false,true)">刷新动态</button></div>
  <div ref="body" class="td-body" :aria-busy="loading">
   <div v-if="error" class="pa-error" role="alert">{{ error }}<button class="text-button" :disabled="loading" @click="retry">重试动态</button></div>
   <p v-if="notice" class="td-callout" role="status">{{ notice }}</p>
   <p v-if="backfill?.status==='pending'||backfill?.status==='running'" class="pa-note">正在补录最近 7 天的完成记录，已检查 {{ backfill.processedTasks }} 项任务。实时动态正常更新。</p>
   <p v-else-if="backfill?.status==='failed'" class="pa-note">历史补录暂未完成，系统会自动重试。实时动态正常更新。</p>
   <template v-if="selected">
    <button class="td-text-button" @click="back">← 返回动态列表</button>
    <div class="pa-detail-heading"><h3>{{ selected.actor.name }} {{ selected.summary }}</h3><p>{{ activityTime(selected.occurredAt,selected.lastOccurredAt) }}<span v-if="selected.historical"> · 历史补录</span></p><p>共 {{ selected.count }} 项，按打开时的记录展示。</p><button v-if="selected.target && selected.target.available !== false && activityRoute(selected.target,projectId) && selected.target.kind !== 'task'" class="td-text-button" @click="navigate(selected.target)">打开相关记录</button></div>
    <article v-for="item in details" :key="item.id" class="pa-detail-item"><h3>{{ item.target?.name || item.summary }}</h3><p>{{ item.summary }}</p><dl v-for="(change,index) in item.changes.filter(c => c.field !== 'ownerId' || !item.changes.some(other => other.field === 'owner'))" :key="index"><dt>{{ activityField(change.field) }}</dt><dd>{{ activityValue(change.field,change.before) }} → {{ activityValue(change.field,change.after) }}</dd></dl><div class="pa-meta"><time :datetime="item.occurredAt">{{ activityTime(item.occurredAt) }}</time><span v-if="item.historical" class="pa-history">历史补录</span></div><button v-if="item.target && item.target.available!==false && activityRoute(item.target,projectId)" class="td-text-button" @click="navigate(item.target)">打开{{ item.target.kind==='task'?'任务':item.target.kind==='risk'?'风险':item.target.kind==='baseline'?'基线':'相关记录' }}</button><p v-else class="pa-note">{{ item.target?.available===false?'该对象已移除或当前无权访问，历史记录仍保留。':'已保留历史信息。' }}</p></article>
    <button v-if="detailsCursor" class="button pa-more" :disabled="loading" @click="loadDetails(true)">加载更多明细</button>
   </template>
   <template v-else><div v-if="page" class="pa-list"><ActivityRow v-for="activity in page.items" :key="activity.id" :activity="activity" @select="open"/></div><p v-if="page && !page.items.length && !loading && !error" class="pa-empty">当前条件下暂无动态。{{ canViewRisks ? '完成任务、调整交付计划或处理重要风险后' : '完成任务、调整交付计划或更新工作分组后' }}，将显示在这里；也可以更换分类或时间范围。</p><button v-if="page?.nextCursor" class="button pa-more" :disabled="loading" @click="load(true)">加载更多动态</button></template>
   <p v-if="loading" class="pa-note" role="status">正在读取动态…</p>
  </div>
  <footer class="td-footer"><small>上海时间 · {{ isDemo?'示例项目真实操作记录':'项目操作记录' }}</small><button class="button" @click="emit('close')">返回项目</button></footer>
 </div>
</dialog>
</template>
