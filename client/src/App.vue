<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { isNavigationFailure, useRoute, useRouter } from 'vue-router';
import { useAuthStore } from './stores/auth';
import { useProjectsStore } from './stores/projects';
import { useProjectRefresh } from './stores/useProjectRefresh';
import { currentProjectId } from './stores/project-scope';
import { privateModule } from './utils/module-privacy';
import WorkspaceShell from './WorkspaceShell.vue';
import LoginPage from './features/auth/LoginPage.vue';
import ChangePasswordPage from './features/auth/ChangePasswordPage.vue';
import SystemSettingsPage from './features/system-settings/SystemSettingsPage.vue';
import { safeSettingsReturnTo } from './features/system-settings/navigation';
import UserManagementPage from './features/auth/UserManagementPage.vue';
import AccountDialog from './features/auth/AccountDialog.vue';
import ProjectListPage from './features/projects/ProjectListPage.vue';
import ProjectFormDialog from './features/projects/ProjectFormDialog.vue';
import type { AuthSession } from '../../shared/src/auth';
import type { ProjectInfo } from '../../shared/src/projects';
const auth=useAuthStore(), projects=useProjectsStore(), route=useRoute(), router=useRouter(), collaboration=useProjectRefresh();
const ready=ref(false), bootError=ref(''), account=ref(false), changingPassword=ref(false), creatingProject=ref(false), notice=ref('');
const reauthDialog=ref<HTMLDialogElement>(), priorUserId=ref('');
const legacy=computed(()=>Boolean(auth.session?.legacyDemo));
const routeProject=computed(()=>typeof route.params.projectId==='string'?route.params.projectId:'');
const hasProject=computed(()=>legacy.value || !!auth.session?.projects.some(p=>p.id===routeProject.value));
// A directory refresh must not unmount an admitted workspace and bypass draft guards.
const admittedProject=ref('');
watch([routeProject,hasProject],([id,allowed])=>{if(!id)admittedProject.value='';else if(allowed)admittedProject.value=id;else if(admittedProject.value!==id)admittedProject.value='';},{immediate:true});
const projectAccessLost=computed(()=>Boolean(routeProject.value&&admittedProject.value===routeProject.value&&!hasProject.value&&!auth.reauthRequired));
const projectActor=computed(()=>auth.actorForProject(routeProject.value));
const settingsReturn=computed(()=>safeSettingsReturnTo(route.query.returnTo,auth.session?.projects.map(p=>p.id)||[]));
function home(){const id=auth.session?.projects.find(p=>p.id===currentProjectId())?.id || auth.session?.projects[0]?.id;return id?`/projects/${encodeURIComponent(id)}/overview`:'/workspace';}
function target(){const requested=route.query.redirect;return typeof requested==='string'&&requested.startsWith('/')&&!requested.startsWith('//')&&!/^\/(login|account\/logout)/.test(requested)?requested:home();}
async function initialize(){bootError.value='';try{await router.isReady();await auth.load();ready.value=true;if(legacy.value&&['workspace','login'].includes(String(route.name)))await router.replace('/projects/phase-one/overview');else if(!auth.user&&!legacy.value&&route.name!=='login')await router.replace({name:'login',query:{redirect:route.fullPath}});else if(auth.user&&!auth.user.mustChangePassword&&['login','logout'].includes(String(route.name)))await router.replace(target());}catch{bootError.value='暂时无法连接账号服务，请重新连接。';}}
async function authenticated(session:AuthSession){notice.value='';if(!session.user?.mustChangePassword)await router.replace(target());}
async function passwordSaved(){changingPassword.value=false;notice.value='密码已更新，其他登录会话已退出。';if(route.name==='login'||route.name==='password')await router.replace(home());}
async function logout(){const previous=route.fullPath;const result=await router.push({name:'logout'});if(isNavigationFailure(result))return;try{await auth.logout();account.value=false;changingPassword.value=false;collaboration.stop();await router.replace({name:'login'});window.location.reload();}catch{notice.value='退出未完成，请重试。';await router.replace(previous);}}
async function recovered(session:AuthSession){if(priorUserId.value&&session.user?.id!==priorUserId.value){window.location.assign('/workspace');return;}if(session.user?.mustChangePassword)return;auth.reauthRequired=false;reauthDialog.value?.close();notice.value='登录已恢复，草稿已保留。请读取最新记录并核对后再提交。';}
async function projectCreated(project:ProjectInfo){creatingProject.value=false;notice.value=`项目「${project.name}」已创建，可以开始安排任务。`;await router.push({name:'overview',params:{projectId:project.id}});}
watch(()=>auth.reauthRequired,required=>{if(required){priorUserId.value=auth.user?.id||'';collaboration.stop();reauthDialog.value?.showModal();}else if(hasProject.value&&routeProject.value&&ready.value)collaboration.start();});
watch(()=>route.name,name=>{if(ready.value&&auth.user&&!auth.user.mustChangePassword&&!auth.reauthRequired&&name==='login')void router.replace(home());});
watch(projectActor,value=>{if(auth.session&&!legacy.value)collaboration.actorId.value=value;},{immediate:true});
watch(projectAccessLost,lost=>{if(lost)collaboration.stop();else if(hasProject.value&&routeProject.value&&ready.value&&!auth.reauthRequired)collaboration.start();});
async function projectRevoked(event: Event) {
  if ((event as CustomEvent<string>).detail !== routeProject.value) return;
  collaboration.stop(); admittedProject.value=''; notice.value='你已无权访问此项目，已返回项目列表。';
  await nextTick(); await router.replace('/workspace'); void projects.load();
}
watch(() => ({ id: routeProject.value, key: auth.projectPrivacyKey(routeProject.value) }), async (current, previous) => {
  if (current.id !== previous.id || current.key === previous.key) return;
  const module = privateModule(route.name);
  const denied = module && !auth.capabilities(routeProject.value)[module];
  // Unmount editors first: permission revocation must bypass their dirty guards.
  await nextTick();
  if (denied) await router.replace({ name: 'overview', params: { projectId: routeProject.value } });
  else if (route.query.notifications) {
    const { notifications: _notifications, ...query } = route.query;
    await router.replace({ path: route.path, query });
  }
});
function sessionExpired(){if(auth.user)auth.markExpired();}
onMounted(()=>{initialize();window.addEventListener('gw-session-expired',sessionExpired);window.addEventListener('gw-project-access-revoked',projectRevoked);});
onUnmounted(()=>{window.removeEventListener('gw-session-expired',sessionExpired);window.removeEventListener('gw-project-access-revoked',projectRevoked);});
</script>
<template>
 <div v-if="bootError" class="auth-root-state" role="alert"><h1>连接暂时不可用</h1><p>{{ bootError }}</p><button class="button primary" @click="initialize">重新连接</button></div>
 <div v-else-if="!ready" class="auth-root-state" role="status">正在检查登录状态…</div>
 <LoginPage v-else-if="!auth.user&&!legacy" @authenticated="authenticated"/>
 <ChangePasswordPage v-else-if="(auth.user?.mustChangePassword&&!auth.reauthRequired)||changingPassword||route.name==='password'" :force="Boolean(auth.user?.mustChangePassword)" @saved="passwordSaved" @cancel="changingPassword=false;router.replace(home())" @logout="logout"/>
 <template v-else>
  <div v-if="route.name==='logout'" class="auth-root-state" role="status">正在退出登录…</div>
  <section v-else-if="route.name==='system-settings'" class="account-workspace"><header><button class="button" @click="router.push(settingsReturn)">{{ settingsReturn==='/workspace'?'← 返回工作空间':'← 返回原项目' }}</button><span>{{ auth.user?.name }} · {{ auth.user?.systemRole==='admin'?'系统管理员':'已登录' }}</span></header><SystemSettingsPage/></section>
  <section v-else-if="route.name==='users'" class="account-workspace"><header><button class="button" @click="router.push(home())">← 返回工作空间</button><span>{{ auth.user?.name }} · {{ auth.user?.systemRole==='admin'?'系统管理员':'已登录' }}</span></header><UserManagementPage v-if="auth.user?.systemRole==='admin'" @notify="notice=$event"/><div v-else class="auth-root-state" role="alert">当前账号没有用户管理权限。</div></section>
  <WorkspaceShell v-else-if="routeProject&&(hasProject||admittedProject===routeProject||(auth.reauthRequired&&priorUserId))" :key="`${routeProject}:${auth.projectPrivacyKey(routeProject)}`" @account="account=true" @logout="logout" @create-project="creatingProject=true"/>
  <section v-else-if="routeProject" class="auth-root-state"><h1>无法访问此项目</h1><p>项目不存在，或你的访问权限已发生变化。请选择有权访问的项目。</p><button class="button primary" @click="router.push('/workspace')">返回项目列表</button></section>
  <ProjectListPage v-else @create="creatingProject=true" @account="account=true" @logout="logout"/>
  <AccountDialog v-if="account" @close="account=false" @change-password="account=false;changingPassword=true"/>
  <ProjectFormDialog v-if="creatingProject" @close="creatingProject=false" @saved="projectCreated"/>
 </template>
 <div v-if="projectAccessLost" class="auth-access-notice" role="alert"><p>此项目的访问权限已变化。当前页面和填写内容已保留；后续读取与提交将校验最新权限。</p><button class="button" @click="router.push('/workspace')">返回项目列表</button></div>
 <p v-if="notice" class="auth-global-notice" role="status">{{ notice }}<button aria-label="关闭账号提示" @click="notice=''">×</button></p>
 <dialog ref="reauthDialog" class="reauth-dialog" aria-label="登录已过期" @cancel.prevent><template v-if="auth.reauthRequired"><p class="reauth-description">登录已过期或账号状态发生变化。当前草稿保留，请重新登录；更换账号将清理原页面。</p><ChangePasswordPage v-if="auth.user?.mustChangePassword" force @saved="recovered" @logout="logout"/><LoginPage v-else reauth @authenticated="recovered"/><div class="reauth-exit"><button class="button" @click="logout">退出当前工作空间</button></div></template></dialog>
</template>
<style scoped>
.auth-access-notice{position:fixed;top:72px;left:50%;transform:translateX(-50%);z-index:190;max-width:calc(100% - 32px);width:640px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:12px;align-items:center;background:var(--surface);border:1px solid var(--line-strong);border-radius:12px;box-shadow:var(--shadow)}.auth-access-notice p{flex:1;min-width:180px;line-height:1.6}.auth-root-state{min-height:100dvh;padding:32px 20px;display:flex;flex-direction:column;justify-content:center;align-items:center;gap:20px;text-align:center}.auth-root-state h1{font-size:22px}.account-workspace{max-width:1280px;margin:auto;padding:24px}.account-workspace>header{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:24px}.auth-global-notice{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);max-width:calc(100% - 32px);width:max-content;padding:12px 16px;border:1px solid var(--line-strong);border-radius:12px;background:var(--surface);box-shadow:var(--shadow);z-index:200;display:flex;gap:12px;align-items:center}.auth-global-notice button{min-width:44px;min-height:44px}.reauth-dialog{max-width:680px;width:calc(100% - 24px);max-height:calc(100dvh - 24px);border:1px solid var(--line-strong);border-radius:18px;padding:0;background:var(--bg)}.reauth-dialog::backdrop{background:#1b223380}.reauth-exit{padding:0 20px 20px;text-align:center}.reauth-description{padding:20px;color:var(--secondary);line-height:1.7}.reauth-dialog :deep(.auth-page){min-height:unset}@media(max-width:767px){.account-workspace{padding:16px}}
</style>
