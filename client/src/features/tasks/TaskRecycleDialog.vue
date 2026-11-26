<script setup lang="ts">
import {computed,nextTick,onMounted,onBeforeUnmount,ref} from 'vue';
import {useAuthStore} from '../../stores/auth';
import {visibleTarget} from '../../utils/module-privacy';
import {useRouter} from 'vue-router';
import type {TaskWorkspace} from '../../../../shared/src/tasks';
import type {RecyclePreview,RecycleBlocker} from '../../../../shared/src/task-recycle';
import {previewTaskRecycle,writeTaskRecycle} from '../../api/tasks';
import {PlanningError} from '../../api/planning';
import './task-recycle.css';
const props=defineProps<{workspace:TaskWorkspace;taskId:string;actorId:string;operation:'delete'|'restore'}>();
const emit=defineEmits<{close:[];saved:[taskId:string]}>();
const auth=useAuthStore();
const canResolve=(b:RecycleBlocker)=>b.id!=='restricted' && visibleTarget(b.kind,auth.capabilities(props.workspace.project.id));
const router=useRouter(),dialog=ref<HTMLDialogElement>(),preview=ref<RecyclePreview>(),reason=ref(''),error=ref(''),busy=ref(false),checking=ref(false),stale=ref(false);
const title=computed(()=>props.operation==='delete'?'删除任务':'恢复任务');
let key='',payload='';
async function check(){checking.value=true;error.value='';stale.value=true;try{preview.value=await previewTaskRecycle(props.workspace,props.actorId,props.taskId,props.operation);stale.value=false;}catch(e){error.value=e instanceof Error?e.message:'检查失败，请重试。';}finally{checking.value=false;}}
function confirmNavigation(){return !busy.value&&(!reason.value.trim()||window.confirm('原因尚未提交，离开将丢弃填写内容。是否离开？'));}
function close(){if(confirmNavigation())emit('close');}
function beforeUnload(event:BeforeUnloadEvent){if(busy.value||reason.value.trim()){event.preventDefault();event.returnValue='';}}
async function save(){if(!preview.value||busy.value||stale.value||checking.value||preview.value.blockers.length||!reason.value.trim())return;
 const body={previewToken:preview.value.previewToken,reason:reason.value.trim()},text=JSON.stringify(body);if(payload!==text){payload=text;key=crypto.randomUUID();}
 busy.value=true;error.value='';try{await writeTaskRecycle(props.workspace,props.actorId,props.taskId,props.operation,body,key);reason.value='';emit('saved',props.taskId);}catch(e){error.value=e instanceof Error?e.message:'保存失败，请重试。';if(e instanceof PlanningError&&[403,404,409,422].includes(e.status))stale.value=true;}finally{busy.value=false;}}
function target(b:RecycleBlocker){const params={projectId:props.workspace.project.id};if(b.kind==='child'||b.kind==='parent')return {name:'task-detail',params:{...params,taskId:b.id}};if(b.kind==='member')return {name:'settings',params};if(b.kind==='workstream')return {name:'workstreams',params};if(b.kind==='risk')return {name:'risk-detail',params:{...params,riskId:b.id}};return {name:'plan',params,query:b.kind==='milestone'?{view:'milestones',milestone:b.id}:{view:'gantt',task:props.taskId}};}
async function resolve(b:RecycleBlocker){if(canResolve(b)&&confirmNavigation()){emit('close');await router.push(target(b));}}
onMounted(async()=>{window.addEventListener('beforeunload',beforeUnload);await nextTick();dialog.value?.showModal();await check();});
onBeforeUnmount(()=>window.removeEventListener('beforeunload',beforeUnload));
defineExpose({confirmNavigation});
</script>
<template>
 <dialog ref="dialog" class="recycle-dialog" :aria-label="title" @cancel.prevent="close">
  <header><h2>{{title}}</h2><button class="button" :disabled="busy" aria-label="关闭删除或恢复确认" @click="close">关闭</button></header>
  <div class="recycle-body">
   <p v-if="checking" role="status">正在检查任务及关联…</p>
   <template v-if="preview"><h3>{{preview.task.wbs}} {{preview.task.title}}</h3><p>{{workspace.project.name}} · {{preview.task.owner}} · {{preview.task.reviewStatus==='submitted'?'待验收':({todo:'待办',in_progress:'进行中',done:'已完成',cancelled:'已取消'}[preview.task.status])}}</p>
    <template v-if="operation==='delete'"><h3>删除影响</h3><ul><li>从任务列表、看板、搜索和当前甘特图移除。</li><li>从当前任务统计和人员分析中排除。</li><li>保留任务内容、成果、验收记录和历史基线。</li><li>仅项目负责人、项目管理员可以恢复。</li></ul><p v-if="preview.task.reviewStatus==='submitted'" class="recycle-warning">删除后停止待验收处理和提醒。</p><p v-if="preview.task.status==='done'" class="recycle-warning">当前完成率和人员统计将重新计算，历史快照保持原值。</p></template>
    <template v-else><h3>恢复影响</h3><p>恢复原状态、进度（{{preview.task.progress}}%）、计划日期和成果，重新纳入当前统计。</p><p>原计划：{{preview.task.start||'待排期'}} → {{preview.task.end||'待排期'}}</p><p>已解除的依赖、里程碑和风险关联不会自动重建。</p></template>
    <p v-if="operation==='restore' && preview.workstreamChange" class="recycle-warning">父任务已调整分组，恢复时将从「{{preview.workstreamChange.fromName}}」归入父任务当前的「{{preview.workstreamChange.toName}}」，删除时的历史记录保留。</p>
    <h3>{{preview.blockers.length?'请先处理以下关联或失效条件':'关联检查：已通过'}}</h3>
    <ul v-if="preview.blockers.length" class="recycle-blockers"><li v-for="(b,i) in preview.blockers" :key="`${b.kind}-${b.id}-${i}`"><strong>{{b.title}}</strong><p>{{b.message}}</p><button v-if="canResolve(b)" class="button" :disabled="busy" @click="resolve(b)">前往处理</button></li></ul>
   </template>
   <label class="recycle-field">{{operation==='delete'?'删除原因':'恢复原因'}} *<textarea v-model="reason" :disabled="busy" maxlength="500" rows="4" required :placeholder="`说明本次${operation==='delete'?'删除':'恢复'}的原因，保存后将留下记录`"/><small>{{reason.length}}/500 · 必填，不接受纯空格</small></label>
   <p v-if="error" role="alert" class="recycle-warning">{{error}}</p>
  </div>
  <footer><button class="button" :disabled="busy" @click="close">{{operation==='delete'?'保留任务':'取消'}}</button><button v-if="!preview||stale||preview.blockers.length" class="button" :disabled="busy||checking" @click="check">重新检查</button><button class="button" :class="operation==='delete'?'recycle-danger':'primary'" :disabled="busy||checking||stale||!preview||!!preview.blockers.length||!reason.trim()" @click="save">{{busy?(operation==='delete'?'正在移入…':'正在恢复…'):(operation==='delete'?'移入回收站':'确认恢复任务')}}</button></footer>
 </dialog>
</template>
