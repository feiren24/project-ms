<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { ProjectInfo } from '../../../../shared/src/projects';
import { createProject, updateProject, fetchProject } from '../../api/projects';
import { fetchSettings } from '../../api/settings';
import { PlanningError } from '../../api/planning';
import { useProjectsStore } from '../../stores/projects';
import { useAuthStore } from '../../stores/auth';
import './projects.css';
const props=defineProps<{ project?: ProjectInfo; planVersion?: number }>();
const emit=defineEmits<{ close: []; saved: [project: ProjectInfo] }>();
const projects=useProjectsStore(), dialog=ref<HTMLDialogElement>(), busy=ref(false), error=ref(''), stale=ref(false), confirming=ref(false);
const auth=useAuthStore();
const canSave=computed(()=>props.project ? !!auth.actorForProject(props.project.id) : projects.canCreate);
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai'}).format(new Date());
const draft=reactive({name:props.project?.name||'',goal:props.project?.goal||'',start:props.project?.start||today,end:props.project?.end||''});
const committed=ref(false);
const initial=JSON.stringify(draft), dirty=computed(()=>!committed.value&&JSON.stringify(draft)!==initial);
const version=ref(props.project?.version||1), planVersion=ref(props.planVersion||1);
let key=crypto.randomUUID();
watch(draft,()=>{key=crypto.randomUUID();confirming.value=false;});
function confirmNavigation() { return !busy.value && (!dirty.value || window.confirm('项目资料尚未保存，离开将丢弃填写内容。是否离开？')); }
function close() { if(confirmNavigation())emit('close'); }
function review() { if(draft.end<draft.start){error.value='结束日期不能早于开始日期。';return;} error.value='';confirming.value=true; }
async function save() {
 if(busy.value||stale.value||!canSave.value)return;busy.value=true;error.value='';
 try {
  const body={name:draft.name.trim(),goal:draft.goal.trim(),start:draft.start,end:draft.end};
  const result=props.project ? await updateProject(props.project.id,{...body,expectedVersion:version.value,expectedPlanVersion:planVersion.value},key) : await createProject(body,key);
  projects.upsert(result);committed.value=true;busy.value=false;emit('saved',result);
 } catch(e){error.value=e instanceof Error?e.message:'保存失败，请重试。';stale.value=e instanceof PlanningError && [403,409].includes(e.status);} finally{busy.value=false;}
}
async function recover() {
 busy.value=true;error.value='';
 try { if(props.project){const [project,settings]=await Promise.all([fetchProject(props.project.id),fetchSettings(props.project.id)]);version.value=project.version;planVersion.value=settings.planVersion;}else { await projects.load(); if (projects.error) throw new Error(projects.error); if (!projects.canCreate) throw new Error('当前账号没有创建项目权限，填写内容已保留。请联系管理员恢复权限。'); } stale.value=false;confirming.value=false;key=crypto.randomUUID();error.value='已读取最新状态，填写内容已保留。请重新核对后提交。'; }
 catch(e){error.value=e instanceof Error?e.message:'读取失败，请重试。';}finally{busy.value=false;}
}
const removeGuard=useRouter().beforeEach(()=>confirmNavigation());
function beforeUnload(e:BeforeUnloadEvent){if(dirty.value||busy.value){e.preventDefault();e.returnValue='';}}
onMounted(()=>{dialog.value?.showModal();window.addEventListener('beforeunload',beforeUnload);});
onBeforeUnmount(()=>{removeGuard();dialog.value?.close();window.removeEventListener('beforeunload',beforeUnload);});
defineExpose({confirmNavigation});
</script>
<template>
 <dialog ref="dialog" class="project-dialog" aria-labelledby="project-form-title" @cancel.prevent="close">
  <header><div><span class="eyebrow">{{ project ? 'PROJECT SETTINGS' : 'NEW PROJECT' }}</span><h2 id="project-form-title">{{ confirming ? '确认项目资料' : project ? '编辑项目资料' : '创建新项目' }}</h2></div><button class="project-text" :disabled="busy" aria-label="关闭项目表单" @click="close">关闭</button></header>
  <form @submit.prevent="review"><div class="project-dialog-body">
   <p v-if="!canSave" class="project-error" role="alert">当前没有此操作的权限，填写内容已保留。请联系项目负责人或管理员。</p>
   <p v-if="error" class="project-error" role="alert">{{ error }}</p><button v-if="stale" class="button" type="button" :disabled="busy" @click="recover">读取最新状态并保留填写</button>
   <template v-if="!confirming"><label>项目名称<input v-model="draft.name" required maxlength="120" :disabled="busy" placeholder="例如：客户协作平台"/></label><label>项目目标<textarea v-model="draft.goal" required maxlength="2000" rows="4" :disabled="busy" placeholder="说明本项目要完成什么，以及如何判断完成"/></label><div class="project-date-fields"><label>开始日期<input v-model="draft.start" type="date" required :disabled="busy"/></label><label>结束日期<input v-model="draft.end" type="date" :min="draft.start" required :disabled="busy"/></label></div></template>
   <dl v-else class="project-facts"><div><dt>项目名称</dt><dd>{{ draft.name }}</dd></div><div><dt>项目目标</dt><dd>{{ draft.goal }}</dd></div><div><dt>计划日期</dt><dd>{{ draft.start }} → {{ draft.end }}</dd></div></dl>
   <p class="project-notice">{{ project ? '修改项目资料不会移动任务日期，也不会改写历史基线。日期调整不能排除已有计划。' : '从空白项目开始：你将成为项目负责人，默认包含“通用工作”分组。项目没有示例任务、风险或基线，工作日历与个人容量需要后续确认。' }}</p>
  </div><footer><button class="button" type="button" :disabled="busy" @click="confirming ? confirming=false : close()">{{ confirming ? '返回修改' : '取消' }}</button><button v-if="!confirming" class="button primary" :disabled="busy||stale||!canSave">核对项目资料</button><button v-else class="button primary" type="button" :disabled="busy||stale||!canSave" @click="save">{{ busy ? '正在保存…' : project ? '确认保存项目' : '确认创建项目' }}</button></footer></form>
 </dialog>
</template>
