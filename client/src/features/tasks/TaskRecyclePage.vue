<script setup lang="ts">
import {computed,onMounted,ref,watch,onBeforeUnmount} from 'vue';
import {useRouter,useRoute,onBeforeRouteLeave,onBeforeRouteUpdate} from 'vue-router';
import {useAuthStore} from '../../stores/auth';
import {currentProjectId,useProjectView} from '../../stores/project-scope';
import {fetchTaskOptions,fetchRecyclePage,fetchRecycledTask} from '../../api/tasks';
import type {TaskWorkspace} from '../../../../shared/src/tasks';
import type {RecyclePage,RecycledTask} from '../../../../shared/src/task-recycle';
import TaskRecycleDialog from './TaskRecycleDialog.vue';
import {defaultTaskView} from './task-view';
import './task-recycle.css';
const router=useRouter(),route=useRoute(),auth=useAuthStore(),projectId=currentProjectId();
const taskView=useProjectView('tasks',defaultTaskView);
const actorId=computed(()=>auth.session?.legacyDemo?taskView.actor:auth.actorForProject(projectId));
const emit=defineEmits<{'overview-changed':[];notify:[message:string]}>();
const filters=ref({query:'',deletedBy:'',from:'',to:'',page:'1'}),page=ref<RecyclePage>(),workspace=ref<TaskWorkspace>(),record=ref<RecycledTask>(),error=ref(''),loading=ref(false),restoring=ref(false),restoredId=ref(''),modal=ref<InstanceType<typeof TaskRecycleDialog>>();
let disposed=false,sequence=0,timer:ReturnType<typeof setTimeout>|undefined;
const date=(s:string)=>new Date(s).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false});
async function load(){const seq=++sequence;loading.value=true;error.value='';record.value=undefined;page.value=undefined;try{const [p,w]=await Promise.all([fetchRecyclePage(projectId,actorId.value,filters.value),fetchTaskOptions(projectId)]);const r=typeof route.query.task==='string'?await fetchRecycledTask(projectId,actorId.value,route.query.task):undefined;if(disposed||seq!==sequence)return;page.value=p;filters.value.page=String(p.page);workspace.value=w;record.value=r;}catch(e){if(!disposed&&seq===sequence)error.value=e instanceof Error?e.message:'回收站读取失败，请重试。';}finally{if(seq===sequence)loading.value=false;}}
function select(id:string){void router.push({name:'task-recycle',params:{projectId},query:{task:id}});}
async function restored(id:string){restoring.value=false;restoredId.value=id;emit('overview-changed');emit('notify','任务已恢复，原因与历史已保存。');await router.replace({name:'task-recycle',params:{projectId}});await load();}
function protect(){return modal.value?.confirmNavigation()??true;}
onBeforeRouteLeave(protect);onBeforeRouteUpdate(protect);
watch(()=>route.query.task,()=>{void load();});
watch(()=>[filters.value.query,filters.value.deletedBy,filters.value.from,filters.value.to],()=>{clearTimeout(timer);filters.value.page='1';timer=setTimeout(()=>void load(),250);});
watch(actorId,()=>{record.value=undefined;restoring.value=false;void load();});
onMounted(load);onBeforeUnmount(()=>{disposed=true;clearTimeout(timer);});
</script>
<template>
 <section class="task-page recycle-page">
  <header class="recycle-page-header"><div><span class="eyebrow">TASK HISTORY</span><h1>已删除任务</h1><p>保留删除原因和历史，任务内容只读。仅项目管理人员可以恢复。</p></div><button class="button" @click="router.push({name:'tasks',params:{projectId}})">返回任务管理</button></header>
  <p v-if="workspace?.project.isDemo" class="task-demo-note">DEMO · 示例项目，数据与操作仅用于演示。</p>
  <div v-if="restoredId" class="recycle-notice" role="status">任务已恢复。<button class="button" @click="router.push({name:'task-detail',params:{projectId,taskId:restoredId}})">查看任务</button></div>
  <form class="recycle-filters" @submit.prevent="load"><label>搜索任务<input v-model="filters.query" type="search" placeholder="任务名称或编号" maxlength="300"/></label><label>删除人<select v-model="filters.deletedBy"><option value="">全部删除人</option><option v-for="a in page?.deletors" :key="a.id" :value="a.id">{{a.name}}</option></select></label><label>删除开始日期<input v-model="filters.from" type="date"/></label><label>删除结束日期<input v-model="filters.to" type="date"/></label></form>
  <p v-if="loading" role="status">正在读取回收站…</p><div v-if="error" role="alert" class="recycle-warning">{{error}}<button class="button" @click="load">重新加载</button></div>
  <template v-if="page&&!loading"><p>共 {{page.total}} 项{{page.canRestore?'':' · 仅显示你创建的任务'}}</p><div v-if="!page.items.length" class="task-empty"><h2>暂无已删除任务</h2><p>当前权限和筛选范围内没有删除记录，可修改筛选或返回任务管理。</p></div><article v-for="item in page.items" :key="item.task.id" class="recycle-card"><div class="recycle-card-heading"><h2>{{item.task.wbs}} {{item.task.title}}</h2><button class="button" @click="select(item.task.id)">查看记录</button></div><p>原负责人：{{item.task.owner}} · 原状态：{{item.task.reviewStatus==='submitted'?'待验收':({todo:'待办',in_progress:'进行中',done:'已完成',cancelled:'已取消'}[item.task.status])}}</p><p>删除人：{{item.deletedByName}} · {{date(item.deletedAt)}}</p><p class="recycle-reason">删除原因：{{item.reason}}</p></article><div class="recycle-pagination"><button class="button" :disabled="page.page<=1" @click="filters.page=String(page.page-1);load()">上一页</button><span>{{page.page}} / {{Math.max(1,Math.ceil(page.total/page.pageSize))}}</span><button class="button" :disabled="page.page*page.pageSize>=page.total" @click="filters.page=String(page.page+1);load()">下一页</button></div></template>
  <section v-if="record" class="recycle-record" aria-label="删除记录"><header class="recycle-card-heading"><h2>{{record.task.title}} · 已删除</h2><button class="button" @click="router.push({name:'task-recycle',params:{projectId}})">关闭记录</button></header><p>创建者：{{record.task.creatorName||'历史任务，创建者未记录'}} · 原负责人：{{record.task.owner}}</p><h3>删除原因</h3><p class="recycle-prose">{{record.reason}}</p><details open><summary>任务内容</summary><p class="recycle-prose">{{record.task.description||'暂无任务描述'}}</p><p>原计划：{{record.task.start||'待排期'}} → {{record.task.end||'待排期'}} · 进度 {{record.task.progress}}%</p><p>预计工时：{{record.task.effortHours??'未估算'}}</p><h4>验收标准</h4><p class="recycle-prose">{{record.task.acceptanceCriteria||'未填写'}}</p><h4>成果说明</h4><p class="recycle-prose">{{record.task.evidence||'暂无成果'}}</p></details><details><summary>验收记录（{{record.task.submissions.length}}）</summary><article v-for="s in record.task.submissions" :key="s.id"><h4>第 {{s.version}} 版 · {{({submitted:'待验收',accepted:'已通过',rejected:'已退回',invalidated:'已失效'}[s.status])}}</h4><p class="recycle-prose">{{s.snapshot?.title}} · {{s.snapshot?.acceptanceCriteria}}</p><p class="recycle-prose">{{s.evidence}}</p><p class="recycle-prose">{{s.comment}}</p><time>{{date(s.createdAt)}}</time></article></details><details><summary>活动记录</summary><article v-for="e in record.task.events" :key="e.id"><p>{{e.actor}} · {{date(e.createdAt)}}</p><p class="recycle-prose">{{e.text}}</p></article></details><h3>删除与恢复历史</h3><article v-for="e in record.history" :key="e.id"><p>{{e.action==='delete'?'删除':'恢复'}} · {{e.actor}} · {{date(e.createdAt)}}</p><p class="recycle-prose">{{e.reason}}</p></article><button v-if="record.canRestore" class="button primary" @click="restoring=true">检查并恢复任务</button></section>
  <TaskRecycleDialog v-if="restoring&&record&&workspace" ref="modal" :workspace="workspace" :task-id="record.task.id" :actor-id="actorId" operation="restore" @close="restoring=false" @saved="restored"/>
 </section>
</template>
