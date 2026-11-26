<script setup lang="ts">
import { operationReasonPolicy } from '../../../../shared/src/operation-reasons';

import { projectRoleLabels, projectRoleDescriptions } from '../../../../shared/src/permissions';

import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { addMembership, fetchMemberships } from '../../api/projects';
import { PlanningError } from '../../api/planning';
import { useAuthStore } from '../../stores/auth';
import type { MembershipWorkspace } from '../../../../shared/src/projects';
import type { ProjectMember } from '../../../../shared/src/settings';
import './projects.css';
const props=defineProps<{projectId:string;legacyMember?:ProjectMember}>();
const emit=defineEmits<{close:[];saved:[]}>();
const data=ref<MembershipWorkspace>(),dialog=ref<HTMLDialogElement>(),busy=ref(false),loading=ref(false),error=ref(''),stale=ref(false),confirming=ref(false);
const query=ref(''),userId=ref(''),role=ref<ProjectMember['role']>(props.legacyMember?.role||'member'),reason=ref('');
const auth=useAuthStore();
const canManage=computed(()=>!!data.value?.canManage&&!!auth.actorForProject(props.projectId));
const accounts=computed(()=>data.value?.accounts.filter(a=>`${a.name} ${a.username}`.toLowerCase().includes(query.value.toLowerCase()))||[]);
const restoringMember=computed(()=>data.value?.members.find(m=>m.userId===userId.value&&m.removedAt));
const reasonPolicy=computed(()=>operationReasonPolicy({domain:'membership',action:'add',role:role.value,legacy:!!props.legacyMember}));
const selected=computed(()=>data.value?.accounts.find(a=>a.id===userId.value));
let key=crypto.randomUUID();
watch([userId,role,reason],()=>{key=crypto.randomUUID();confirming.value=false;});
function confirmNavigation(){return !busy.value&&(!(userId.value||reason.value)||window.confirm('成员关联尚未保存，离开将丢弃填写内容。是否离开？'));}
function close(){if(confirmNavigation())emit('close');}
async function load(){loading.value=true;error.value='';try{data.value=await fetchMemberships(props.projectId);stale.value=false;confirming.value=false;key=crypto.randomUUID();}catch(e){error.value=e instanceof Error?e.message:'读取失败，请重试。';}finally{loading.value=false;}}
async function save(){if(!data.value||busy.value||stale.value||!canManage.value)return;busy.value=true;error.value='';try{await addMembership(props.projectId,{expectedVersion:data.value.version,expectedPlanVersion:data.value.planVersion,userId:userId.value,role:role.value,...(props.legacyMember?{legacyMemberId:props.legacyMember.id}:{}),reason:reasonPolicy.value==='required'?reason.value.trim():undefined},key);busy.value=false;emit('saved');}catch(e){error.value=e instanceof Error?e.message:'保存失败，请重试。';stale.value=e instanceof PlanningError&&[403,409].includes(e.status);}finally{busy.value=false;}}
const removeGuard=useRouter().beforeEach(()=>confirmNavigation());
function beforeUnload(e:BeforeUnloadEvent){if(userId.value||reason.value||busy.value){e.preventDefault();e.returnValue='';}}
onMounted(()=>{dialog.value?.showModal();void load();window.addEventListener('beforeunload',beforeUnload);});
onBeforeUnmount(()=>{removeGuard();dialog.value?.close();window.removeEventListener('beforeunload',beforeUnload);});
</script>
<template>
 <dialog ref="dialog" class="project-dialog" :aria-label="legacyMember ? '关联成员登录账号' : '添加项目成员'" @cancel.prevent="close"><header><h2 id="membership-title">{{ legacyMember ? '关联成员登录账号' : '添加项目成员' }}</h2><button class="project-text" :disabled="busy" aria-label="关闭成员关联" @click="close">关闭</button></header>
  <form @submit.prevent="confirming=true"><div class="project-dialog-body"><p v-if="error" class="project-error" role="alert">{{ error }}<button v-if="stale||!data" class="project-text" type="button" :disabled="loading||busy" @click="load">读取最新成员并保留填写</button></p><p v-if="loading" role="status">正在读取可添加账号…</p>
   <p v-if="legacyMember" class="project-notice">将登录账号明确关联到「{{ legacyMember.name }}」。保留原成员 ID、项目角色、启停状态、任务与历史责任，不按姓名自动匹配。</p>
   <p v-if="data&&!canManage" class="project-error" role="alert">你已没有项目成员管理权限，填写内容已保留。请联系项目负责人。</p><template v-if="data&&!confirming"><label>搜索可添加账号<input v-model="query" type="search" placeholder="姓名或登录账号" :disabled="busy"/></label><label>登录账号<select aria-label="登录账号" v-model="userId" required :disabled="busy"><option value="" disabled>请选择已开通的账号</option><option v-for="account in accounts" :key="account.id" :value="account.id">{{ account.name }} · {{ account.username }}</option></select></label><p v-if="!accounts.length" class="project-notice">{{ query ? '没有匹配的账号，请调整搜索。' : '没有可添加的启用账号。请联系管理员开通账号；已在项目中的成员请在列表中编辑。' }}</p><label>项目角色<select aria-label="项目角色" v-model="role" :disabled="busy||!!legacyMember"><option value="manager">项目负责人</option><option value="project_admin">项目管理员</option><option value="member">项目成员</option><option value="viewer">只读成员</option></select><small>{{ projectRoleDescriptions[role] }}</small></label><p v-if="restoringMember" class="project-notice">此账号曾被移除。重新添加将恢复「{{ restoringMember.name }}」的原成员身份与历史记录，并应用本次选择的角色。</p><label v-if="reasonPolicy === 'required'">操作原因<textarea v-model="reason" required maxlength="500" rows="3" :disabled="busy"/></label></template>
   <dl v-else-if="data" class="project-facts"><div><dt>账号</dt><dd>{{ selected?.name }} · {{ selected?.username }}</dd></div><div><dt>项目角色</dt><dd>{{ projectRoleLabels[role] }}</dd></div><div v-if="reasonPolicy === 'required'"><dt>操作原因</dt><dd>{{ reason }}</dd></div></dl>
   <p class="project-notice">只影响当前项目的成员与权限，不修改全局账号角色，也不会发送外部通知。</p>
  </div><footer><button class="button" type="button" :disabled="busy" @click="confirming?confirming=false:close()">{{ confirming?'返回修改':'取消' }}</button><button v-if="!confirming" class="button primary" :disabled="loading||busy||stale||!selected||!canManage">核对成员信息</button><button v-else class="button primary" type="button" :disabled="busy||stale||loading||!selected||!canManage" @click="save">{{ busy?'正在保存…':legacyMember?'确认关联账号':'确认添加成员' }}</button></footer></form>
 </dialog>
</template>
