<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { AuthError } from '../../api/auth';
import { backupSystemKey, fetchSystemSettings, fetchSystemAudit, saveSystemKey, type SystemKeyStatus, type SystemKeyInput, type SystemSettingsAudit } from '../../api/system-settings';
import '../auth/auth.css';
import './system-settings.css';
const auth=useAuthStore(), router=useRouter();
const status=ref<SystemKeyStatus>(), audit=ref<SystemSettingsAudit>({items:[],page:1,total:0});
const loading=ref(false), auditLoading=ref(false), busy=ref(false), error=ref(''), auditError=ref(''), notice=ref(''), stale=ref(false), denied=ref(false);
const mode=ref<'generate'|'import'>('generate'), secret=ref(''), confirming=ref(false), confirmKind=ref<'configure'|'backup'|'rotate'>('configure'), rotationAcknowledged=ref(false), dialog=ref<HTMLDialogElement>();
const pending=ref<{body:SystemKeyInput;key:string}|null>(null);
const admin=computed(()=>auth.user?.systemRole==='admin'&&!denied.value);
const editable=computed(()=>admin.value&&status.value?.source!=='environment'&&(status.value?.canGenerate||status.value?.canImport));
const canSubmit=computed(()=>editable.value&&!loading.value&&!busy.value&&!stale.value&&!auth.reauthRequired&&(mode.value==='generate'?status.value?.canGenerate:status.value?.canImport));
const canBackup=computed(()=>admin.value&&status.value?.source==='file'&&status.value.state==='ready'&&status.value.canBackup&&!loading.value&&!busy.value&&!stale.value&&!auth.reauthRequired);
const canRotate=computed(()=>admin.value&&status.value?.source==='file'&&status.value.state==='ready'&&status.value.canRotate&&!loading.value&&!busy.value&&!stale.value&&!auth.reauthRequired);
const dirty=computed(()=>!!secret.value||confirming.value||busy.value||!!pending.value);
const labels={missing:'尚未配置',ready:'已就绪',invalid:'配置异常'};
const sources={environment:'服务器环境变量',file:'服务器独立密钥文件',none:'未配置'};
const time=(value:string|null)=>value?new Date(value).toLocaleString('zh-CN',{hour12:false}):'—';
function validKey(value:string){try{return /^[A-Za-z0-9+/]{43}=$/.test(value)&&atob(value).length===32&&btoa(atob(value))===value;}catch{return false;}}
function closeConfirm(){if(busy.value)return;dialog.value?.close();confirming.value=false;rotationAcknowledged.value=false;if(confirmKind.value!=='configure')pending.value=null;}
async function loadAudit(page=audit.value.page){if(auditLoading.value)return;auditLoading.value=true;auditError.value='';try{audit.value=await fetchSystemAudit(page);}catch(e){auditError.value=e instanceof Error?e.message:'操作记录读取失败。';}finally{auditLoading.value=false;}}
async function load(refresh=false){
  if(loading.value||busy.value)return;loading.value=true;error.value='';
  try{
    if(refresh)await auth.refreshForRecovery();
    if(auth.user?.systemRole!=='admin'){denied.value=true;throw new Error('当前账号没有系统设置权限，请联系系统管理员。');}
    denied.value=false;status.value=await fetchSystemSettings();stale.value=false;
    if(!pending.value&&mode.value==='generate'&&!status.value.canGenerate&&status.value.canImport)mode.value='import';
    if(refresh){pending.value=null;closeConfirm();notice.value='已读取最新状态，填写内容已保留。请核对后重新确认。';}
    void loadAudit(refresh?1:audit.value.page);
  }catch(e){error.value=e instanceof Error?e.message:'设置读取失败，请重试。';stale.value=true;}
  finally{loading.value=false;}
}
async function prepare(){
  if(!canSubmit.value)return;error.value='';notice.value='';
  if(mode.value==='import'&&!validKey(secret.value)){error.value='请输入严格 Base64 编码的 32 字节密钥（44 个字符，末尾一个 =），不要包含空格或换行。';return;}
  confirmKind.value='configure';confirming.value=true;await nextTick();dialog.value?.showModal();
}
async function openLifecycle(kind:'backup'|'rotate'){if(kind==='backup'?!canBackup.value:!canRotate.value)return;error.value='';notice.value='';confirmKind.value=kind;rotationAcknowledged.value=false;pending.value=null;confirming.value=true;await nextTick();dialog.value?.showModal();}
async function save(){
  if(!canSubmit.value||!status.value)return;busy.value=true;error.value='';
  pending.value??={body:{expectedVersion:status.value.version,mode:mode.value,...(mode.value==='import'?{key:secret.value}:{})},key:crypto.randomUUID()};
  try{status.value=await saveSystemKey(pending.value.body,pending.value.key);secret.value='';pending.value=null;notice.value='飞书凭据加密已就绪。请返回项目核对机器人和通知规则；已有启用规则将按原设置继续调度。';busy.value=false;closeConfirm();void loadAudit(1);}
  catch(e){error.value=e instanceof Error?e.message:'保存失败，请重试原操作。';if(e instanceof AuthError&&[400,422].includes(e.status))pending.value=null;if(e instanceof AuthError&&[401,403,409].includes(e.status)){stale.value=true;error.value+=' 请刷新状态并保留草稿后重新核对。';} }
  finally{busy.value=false;}
}
function backupFilename(version:number,exportedAt:string){const stamp=new Date(exportedAt).toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');return `goodwork-feishu-master-key-v${version}-${stamp}.txt`;}
async function backup(){
 if(!canBackup.value||!status.value)return;busy.value=true;error.value='';
 try{const result=await backupSystemKey({expectedVersion:status.value.version,confirmed:true});const url=URL.createObjectURL(new Blob([`${result.key}\n`],{type:'text/plain;charset=utf-8'}));try{const anchor=document.createElement('a');anchor.href=url;anchor.download=backupFilename(result.version,result.exportedAt);anchor.click();}finally{URL.revokeObjectURL(url);}notice.value=`V${result.version} 主密钥备份下载已开始。请与同一时期的数据库备份配套保存。`;busy.value=false;closeConfirm();void loadAudit(1);}catch(e){error.value=e instanceof Error?e.message:'备份未开始，请重试。';if(e instanceof AuthError&&[401,403,409].includes(e.status)){stale.value=true;error.value+=' 请刷新状态后重新核对。';}}finally{busy.value=false;}
}
async function rotate(){
 if(!canRotate.value||!status.value||!rotationAcknowledged.value)return;busy.value=true;error.value='';pending.value??={body:{expectedVersion:status.value.version,mode:'rotate',confirmed:true},key:crypto.randomUUID()};
 try{status.value=await saveSystemKey(pending.value.body,pending.value.key);pending.value=null;notice.value=`主密钥已安全更换，${status.value.credentialCount} 个机器人凭据已重新加密；本次更换未触发通知，原有规则继续按原设置运行。请立即备份新主密钥。`;busy.value=false;closeConfirm();void loadAudit(1);}catch(e){error.value=e instanceof Error?e.message:'更换失败，请重试原操作。';if(e instanceof AuthError&&[400,422].includes(e.status))pending.value=null;if(e instanceof AuthError&&[401,403,409].includes(e.status)){stale.value=true;error.value+=' 请刷新状态后重新核对。';}}finally{busy.value=false;}
}
watch([mode,secret],()=>{if(!busy.value&&confirmKind.value==='configure')pending.value=null;});
watch(()=>auth.reauthRequired,value=>{if(value){stale.value=true;closeConfirm();}});
function confirmNavigation(){if(busy.value)return false;if(dirty.value&&!window.confirm('设置尚未完成，离开将清除当前密钥草稿；已提交但未确认的结果可稍后刷新核对。是否离开？'))return false;return true;}
const removeGuard=router.beforeEach((to,from)=>to.fullPath===from.fullPath||confirmNavigation());
function beforeUnload(event:BeforeUnloadEvent){if(dirty.value){event.preventDefault();event.returnValue='';}}
onMounted(()=>{void load();window.addEventListener('beforeunload',beforeUnload);});
onBeforeUnmount(()=>{removeGuard();secret.value='';pending.value=null;dialog.value?.close();window.removeEventListener('beforeunload',beforeUnload);});
</script>
<template>
 <main class="auth-admin system-settings" aria-labelledby="system-settings-title">
  <header class="auth-heading"><div><h1 id="system-settings-title">系统设置</h1><p>系统管理员 · 全部项目共用的服务器配置</p></div><button class="auth-button" :disabled="loading||busy" @click="load(true)">{{ loading?'正在读取…':'刷新状态并保留草稿' }}</button></header>
  <p v-if="error&&!confirming" class="auth-error" role="alert">{{ error }}</p>
  <p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>
  <p v-if="!admin" class="auth-error" role="alert">当前账号没有系统设置权限，请联系系统管理员。</p>
  <p v-if="loading&&!status" class="auth-empty" role="status">正在读取服务器配置…</p>
  <template v-if="status&&admin">
   <section class="system-card" aria-labelledby="system-key-title"><header><div><h2 id="system-key-title">飞书凭据加密</h2><p>保护各项目保存的机器人 Webhook 和签名密钥。</p></div><span class="auth-status" :class="{inactive:status.state!=='ready'}" data-testid="system-key-state">{{ labels[status.state] }}</span></header>
    <dl class="auth-facts"><div><dt>配置来源</dt><dd>{{ sources[status.source] }}{{ status.source==='environment'?' · 只读':'' }}</dd></div><div><dt>影响范围</dt><dd>所有项目的 {{ status.credentialCount }} 个飞书机器人凭据</dd></div><div><dt>最近配置</dt><dd>{{ time(status.updatedAt) }}{{ status.updatedBy?' · '+status.updatedBy:'' }}</dd></div></dl>
    <p v-if="status.message" class="auth-notice">{{ status.message }}</p>
    <p v-if="status.source==='environment'" class="auth-note">环境变量由部署管理员维护，本页不可修改。{{ status.state==='invalid'?'请修复服务器配置后重新读取状态。':'' }}</p>
    <p v-else-if="status.state==='ready'" class="auth-note">主密钥由服务器自动持久化，页面不会显示内容，也不需要手工复制。系统管理员可在明确确认后下载备份或安全更换。</p>
    <p v-if="status.hasCredentials&&status.state!=='ready'&&status.canImport" class="auth-notice">系统已有加密凭据。请使用与原凭据匹配的备份密钥恢复，不能生成新的密钥覆盖。</p><p v-else-if="status.hasCredentials&&status.state!=='ready'" class="auth-notice">系统已有加密凭据，但当前不可导入密钥。请按上方状态提示修复存储或部署配置，再刷新状态。</p>
    <form v-if="editable" class="system-key-form" @submit.prevent="prepare">
     <fieldset :disabled="loading||busy||confirming||!!pending"><legend>配置方式</legend><label v-if="status.canGenerate" class="auth-check"><input v-model="mode" type="radio" value="generate" name="key-mode"/>生成新密钥</label><label v-if="status.canImport" class="auth-check"><input v-model="mode" type="radio" value="import" name="key-mode"/>导入已有密钥</label><p v-if="mode==='generate'" class="auth-note">由服务器生成并保存到独立密钥文件，浏览器不会收到密钥内容。</p><label v-if="mode==='import'" class="auth-field">Base64 主密钥<input v-model="secret" type="password" name="system-key" autocomplete="new-password" spellcheck="false" autocapitalize="off" aria-label="Base64 主密钥"/><small>32 字节，严格 Base64 编码。内容仅在本页内存中暂存，成功后清除。</small></label></fieldset>
     <button class="auth-button primary" :disabled="!canSubmit">核对配置</button>
    </form>
    <aside class="system-backup"><h3>备份、更换与恢复</h3><p>数据库备份不包含主密钥。旧数据库备份需要旧主密钥，新数据库备份需要新主密钥；请按版本配套保管。需要恢复且页面提供恢复表单时，可导入 Base64 主密钥备份。</p><p>飞书机器人的签名密钥属于单个机器人凭据，并不是这里的系统主密钥。更换主密钥只会重新加密已保存凭据并保留机器人、规则和发送记录；本次更换不触发通知，原有规则继续按原设置运行。</p><div v-if="status.source==='file'&&status.state==='ready'" class="system-lifecycle-actions"><button class="auth-button" :disabled="!canBackup" @click="openLifecycle('backup')">备份当前主密钥</button><button class="auth-button" :disabled="!canRotate" @click="openLifecycle('rotate')">安全更换主密钥</button></div><p v-else-if="status.source==='environment'">环境变量主密钥为只读配置，备份和更换须由部署管理员在服务器完成。</p><p v-else-if="status.state==='invalid'&&status.canImport">当前主密钥不可用，生命周期操作已停用。请导入与已有凭据匹配的备份密钥恢复。</p><p v-else-if="status.state==='invalid'">当前主密钥不可用，生命周期操作已停用。请按状态提示修复存储或部署配置后刷新。</p></aside>
   </section>
   <section class="system-card" aria-labelledby="system-audit-title"><header><div><h2 id="system-audit-title">系统操作记录</h2><p>仅记录操作人、时间、动作和结果，不记录密钥内容。</p></div></header>
    <p v-if="auditError" class="auth-error" role="alert">{{ auditError }}<button class="auth-link" @click="loadAudit()">重试读取记录</button></p>
    <p v-if="auditLoading" role="status">正在读取操作记录…</p>
    <template v-if="audit.items.length"><div class="auth-table-shell"><table class="auth-table"><thead><tr><th>时间</th><th>操作人</th><th>动作</th><th>结果</th></tr></thead><tbody><tr v-for="item in audit.items" :key="item.id"><td>{{ time(item.at) }}</td><td>{{ item.actor }}</td><td>{{ item.action }}</td><td>{{ item.result }}</td></tr></tbody></table></div><div class="auth-mobile-users"><article v-for="item in audit.items" :key="item.id" class="auth-user-card"><strong>{{ item.action }} · {{ item.result }}</strong><p>{{ item.actor }}<br/>{{ time(item.at) }}</p></article></div></template>
    <p v-else-if="!auditLoading&&!auditError" class="auth-empty">暂无系统配置记录。确认配置后，操作结果将在此留痕。</p>
    <footer class="system-pagination"><button class="auth-button" :disabled="auditLoading||audit.page<=1" @click="loadAudit(audit.page-1)">上一页</button><span>第 {{ audit.page }} 页 · 共 {{ audit.total }} 条</span><button class="auth-button" :disabled="auditLoading||audit.page*20>=audit.total" @click="loadAudit(audit.page+1)">下一页</button></footer>
   </section>
  </template>
  <dialog v-if="confirming" ref="dialog" class="auth-dialog" aria-labelledby="system-confirm-title" @cancel.prevent="closeConfirm"><header class="auth-dialog-header"><h2 id="system-confirm-title">{{ confirmKind==='backup'?'确认备份当前主密钥':confirmKind==='rotate'?'确认安全更换主密钥':'确认配置飞书凭据加密' }}</h2></header><div class="auth-dialog-body">
   <template v-if="confirmKind==='configure'"><p>配置方式：{{ mode==='generate'?'服务器生成新密钥':'导入已有密钥' }}</p><p>影响范围：所有项目的飞书机器人凭据。</p><p>{{ mode==='generate'?'密钥由服务器生成并自动保存，不需要复制。':'导入内容只在本页内存暂存，并由服务器保存。' }} 数据库备份不能恢复主密钥，配置完成后请单独下载备份。配置不会自动新增或启用规则，也不会发送测试消息。若已有启用的通知规则，恢复密钥后将按原设置继续调度。</p></template>
   <template v-else-if="confirmKind==='backup'"><p>将下载当前 V{{ status?.version }} 主密钥的 Base64 文本文件，内容不会显示在页面或写入浏览器存储。</p><p>数据库备份必须与同一版本主密钥配套保存；下载开始不代表操作系统已经安全保存文件，请核对浏览器下载记录和保管位置。</p></template>
   <template v-else><p>将生成新的系统主密钥，并重新加密所有项目的 {{ status?.credentialCount }} 个已保存机器人凭据。</p><p>机器人、通知规则、测试状态、群确认和发送记录保持不变；本次更换不触发通知，原有规则继续按原设置运行。操作完成后请立即备份新主密钥。</p><label class="auth-check system-ack"><input v-model="rotationAcknowledged" type="checkbox"/>我已理解：旧数据库备份需要旧主密钥，新数据库备份需要新主密钥，并会分别配套保管。</label></template>
   <p>操作人：{{ auth.user?.name }} · 本次操作将记入系统操作记录。</p><p v-if="busy" role="status">{{ confirmKind==='backup'?'正在准备下载…':confirmKind==='rotate'?'正在安全更换并重新加密凭据…':'正在保存配置，请稍候…' }}</p><p v-if="error" class="auth-error" role="alert">{{ error }}</p><button v-if="stale" class="auth-button" :disabled="busy||loading" @click="load(true)">刷新状态并保留草稿</button></div><footer class="auth-dialog-footer">
    <button class="auth-button" :disabled="busy" @click="closeConfirm">{{ confirmKind==='backup'?'取消备份':confirmKind==='rotate'?'取消更换':'返回修改' }}</button>
    <button v-if="confirmKind==='configure'" class="auth-button primary" :disabled="!canSubmit" @click="save">{{ busy?'正在保存…':pending?'重试原操作':'确认保存配置' }}</button>
    <button v-else-if="confirmKind==='backup'" class="auth-button primary" :disabled="!canBackup" @click="backup">{{ busy?'正在准备…':'确认并开始下载' }}</button>
    <button v-else class="auth-button primary" :disabled="!canRotate||!rotationAcknowledged" @click="rotate">{{ busy?'正在更换…':pending?'重试原操作':'确认安全更换' }}</button>
   </footer></dialog>
 </main>
</template>
