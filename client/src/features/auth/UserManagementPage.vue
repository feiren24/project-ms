<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { AuthUser, IssuedCredential } from '../../../../shared/src/auth';
import { AuthError, createUser, fetchUsers, resetPassword, updateUser } from '../../api/auth';
import { useAuthStore } from '../../stores/auth';
import './auth.css';
const emit = defineEmits<{ notify: [message: string] }>();
const auth = useAuthStore(), users = ref<AuthUser[]>([]), loading = ref(false), pageError = ref('');
const query = ref(''), status = ref('all'), creation = ref('all');
const mode = ref<'create' | 'edit' | 'reset' | null>(null), phase = ref<'form' | 'confirm' | 'credential'>('form');
const selected = ref<AuthUser | null>(null), credential = ref<IssuedCredential | null>(null), dialog = ref<HTMLDialogElement>();
const busy = ref(false), error = ref(''), notice = ref(''), errorCode = ref(''), copied = ref(false), recoveryNeeded = ref(false);
const draft = reactive({ username: '', name: '', systemRole: 'user' as 'admin' | 'user', active: true, canCreateProjects: false });
let initial = '', key = crypto.randomUUID();
const filtered = computed(() => users.value.filter(u => (!query.value.trim() || `${u.name} ${u.username}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())) && (status.value === 'all' || u.active === (status.value === 'active')) && (creation.value === 'all' || (u.systemRole === 'admin' || u.canCreateProjects) === (creation.value === 'yes'))));
const adminCount = computed(() => users.value.filter(u => u.active && u.systemRole === 'admin').length);
const self = computed(() => selected.value?.id === auth.user?.id);
const protectedAdmin = computed(() => !!selected.value && (self.value || (selected.value.active && selected.value.systemRole === 'admin' && adminCount.value <= 1)));
const dirty = computed(() => !!mode.value && JSON.stringify(draft) !== initial);
const title = computed(() => phase.value === 'credential' ? '请保存初始登录凭据' : phase.value === 'confirm' ? mode.value === 'reset' ? '确认重置密码' : mode.value === 'create' ? '确认开通账号' : '确认修改账号' : mode.value === 'create' ? '开通账号' : '编辑账号');
watch(draft, () => { key = crypto.randomUUID(); });
async function load() {
  if (loading.value) return;
  loading.value = true; pageError.value = '';
  try { users.value = (await fetchUsers()).users; }
  catch (e) { pageError.value = e instanceof Error ? e.message : '用户列表读取失败，请重试。'; }
  finally { loading.value = false; }
}
function upsert(user: AuthUser) { const i = users.value.findIndex(u => u.id === user.id); if (i < 0) users.value.push(user); else users.value[i] = user; }
async function open(value: 'create' | 'edit' | 'reset', user?: AuthUser) {
  selected.value = user ? { ...user } : null; credential.value = null; copied.value = false;
  Object.assign(draft, { username: user?.username || '', name: user?.name || '', systemRole: user?.systemRole || 'user', active: user?.active ?? true, canCreateProjects: user?.canCreateProjects ?? false });
  initial = JSON.stringify(draft); error.value = ''; notice.value = ''; errorCode.value = ''; recoveryNeeded.value = false; key = crypto.randomUUID();
  mode.value = value; phase.value = value === 'reset' ? 'confirm' : 'form';
  await nextTick(); dialog.value?.showModal();
}
function confirmNavigation() {
  if (busy.value) return false;
  if (credential.value && !window.confirm('初始密码只在本次结果中显示。请确认已经保存并准备交付给该用户，是否关闭？')) return false;
  if (!credential.value && dirty.value && !window.confirm('账号修改尚未保存，离开将丢弃填写内容。是否离开？')) return false;
  return true;
}
function clearDialog() { dialog.value?.close(); mode.value = null; credential.value = null; selected.value = null; error.value = ''; notice.value = ''; }
function close() { if (confirmNavigation()) clearDialog(); }
function prepare() { if (busy.value || recoveryNeeded.value) return; error.value = ''; phase.value = 'confirm'; }
async function save() {
  if (busy.value || recoveryNeeded.value || !mode.value) return;
  busy.value = true; error.value = ''; notice.value = '';
  try {
    const csrf = auth.session?.csrfToken || '';
    if (mode.value === 'create') {
      credential.value = await createUser(csrf, { username: draft.username.trim(), name: draft.name.trim(), systemRole: draft.systemRole, canCreateProjects: draft.canCreateProjects }, key);
    } else if (mode.value === 'reset' && selected.value) {
      credential.value = await resetPassword(csrf, selected.value.id, selected.value.version, key);
    } else if (selected.value) {
      const user = await updateUser(csrf, selected.value.id, { expectedVersion: selected.value.version, name: draft.name.trim(), systemRole: draft.systemRole, active: draft.active, canCreateProjects: draft.canCreateProjects }, key);
      upsert(user); if (self.value && auth.session) auth.session.user = user;
      clearDialog(); emit('notify', '账号已更新。'); return;
    }
    if (credential.value) { upsert(credential.value.user); selected.value = credential.value.user; phase.value = 'credential'; emit('notify', mode.value === 'create' ? '账号已开通，请保存并交付初始凭据。' : '密码已重置，请交付新的初始凭据。'); }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '保存失败，请重试。'; errorCode.value = e instanceof AuthError ? e.code : '';
    recoveryNeeded.value = e instanceof AuthError && (e.status === 409 || e.status === 403);
    if (errorCode.value === 'CREDENTIAL_ALREADY_ISSUED') error.value = '该操作已生成过初始凭据，无法再次显示。请读取最新账号状态，核对后重新发起密码重置。';
  } finally { busy.value = false; }
}
async function recover() {
  if (busy.value) return;
  busy.value = true;
  try {
    // Refresh permissions and optimistic version, keeping typed edits for a new explicit review.
    await auth.refreshForRecovery();
    if (auth.user?.systemRole !== 'admin') throw new Error('当前账号已没有用户管理权限，请联系管理员。');
    users.value = (await fetchUsers()).users;
      const latest = users.value.find(u => selected.value ? u.id === selected.value.id : u.username === draft.username.trim().toLowerCase());
    if (mode.value !== 'create' && !latest) throw new Error('该账号已不可用，请关闭表单后重新查看列表。');
    if (errorCode.value === 'CREDENTIAL_ALREADY_ISSUED') {
      if (!latest) throw new Error('暂未找到已开通的账号，请稍后重新读取。');
      selected.value = { ...latest }; mode.value = 'reset'; phase.value = 'confirm';
      notice.value = '请核对账号，再点击“确认重置密码”。这将生成新凭据并使已有会话退出。';
    } else {
      if (latest) selected.value = { ...latest };
      if (latest && (latest.id === auth.user?.id || (latest.active && latest.systemRole === 'admin' && adminCount.value <= 1))) { draft.systemRole = latest.systemRole; draft.active = latest.active; }
      phase.value = mode.value === 'reset' ? 'confirm' : 'form';
      notice.value = '已读取最新状态。原填写内容已保留，请核对并再次确认提交。';
    }
    key = crypto.randomUUID(); error.value = ''; errorCode.value = ''; recoveryNeeded.value = false;
  } catch (e) { error.value = e instanceof Error ? e.message : '读取失败，请重试。'; }
  finally { busy.value = false; }
}
async function copyCredential() {
  if (!credential.value) return;
  try { await navigator.clipboard.writeText(`登录账号：${credential.value.user.username}\n初始密码：${credential.value.initialPassword}`); copied.value = true; }
  catch { error.value = '无法自动复制，请手动选择账号和密码复制。'; }
}
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value || credential.value || busy.value) { event.preventDefault(); event.returnValue = ''; } }
const removeGuard = useRouter().beforeEach((to, from) => { if (to.fullPath === from.fullPath) return true; if (!confirmNavigation()) return false; credential.value = null; return true; });
onMounted(() => { void load(); window.addEventListener('beforeunload', beforeUnload); });
onBeforeUnmount(() => { removeGuard(); credential.value = null; dialog.value?.close(); window.removeEventListener('beforeunload', beforeUnload); });
defineExpose({ confirmNavigation, refreshForCollaboration: async () => { if (mode.value) return false; await load(); return !pageError.value; } });
</script>
<template>
 <section class="auth-admin" aria-labelledby="users-title">
  <header class="auth-heading"><div><h1 id="users-title">用户管理</h1><p>管理登录账号与创建项目权限。项目成员角色在各项目中设置。</p></div><button class="auth-button primary" :disabled="loading || !!mode" @click="open('create')">＋ 开通账号</button></header>
  <div v-if="pageError" class="auth-error" role="alert">{{ pageError }}<button class="auth-link" :disabled="loading" @click="load">重新读取</button></div>
  <div class="auth-filters"><input v-model="query" type="search" aria-label="搜索用户" placeholder="搜索姓名或登录账号" /><select v-model="status" aria-label="账号状态"><option value="all">全部状态</option><option value="active">已启用</option><option value="inactive">已停用</option></select><select v-model="creation" aria-label="创建项目权限"><option value="all">全部创建权限</option><option value="yes">可创建项目</option><option value="no">不可创建项目</option></select><button class="auth-button" :disabled="loading || !!mode" @click="load">{{ loading ? '正在读取…' : '刷新' }}</button></div>
  <p v-if="loading && !users.length" class="auth-empty" role="status">正在读取账号列表…</p>
  <template v-else-if="filtered.length">
   <div class="auth-table-shell"><table class="auth-table"><thead><tr><th>姓名</th><th>登录账号</th><th>系统角色</th><th>账号状态</th><th>可创建项目</th><th>操作</th></tr></thead><tbody><tr v-for="user in filtered" :key="user.id" data-testid="user-row"><td>{{ user.name }}<small v-if="user.id === auth.user?.id"> · 当前账号</small></td><td>{{ user.username }}</td><td>{{ user.systemRole === 'admin' ? '系统管理员' : '普通用户' }}</td><td><span class="auth-status" :class="{ inactive: !user.active }">{{ user.active ? '已启用' : '已停用' }}</span><small v-if="user.mustChangePassword" style="display:block;margin-top:4px">需设置新密码</small></td><td>{{ user.systemRole === 'admin' || user.canCreateProjects ? '是' : '否' }}</td><td><div class="auth-inline-actions"><button class="auth-link" :aria-label="`编辑账号 ${user.username}`" @click="open('edit', user)">编辑</button><button class="auth-link" :aria-label="`重置密码 ${user.username}`" :disabled="user.id === auth.user?.id || !user.active" :title="user.id === auth.user?.id ? '请从我的账号修改自己的密码' : !user.active ? '请先启用账号' : undefined" @click="open('reset', user)">重置密码</button></div></td></tr></tbody></table></div>
   <div class="auth-mobile-users"><article v-for="user in filtered" :key="user.id" class="auth-user-card" data-testid="user-card"><header><strong>{{ user.name }}</strong><span class="auth-status" :class="{ inactive: !user.active }">{{ user.active ? '已启用' : '已停用' }}</span></header><p>{{ user.username }}{{ user.id === auth.user?.id ? ' · 当前账号' : '' }}<br />{{ user.systemRole === 'admin' ? '系统管理员' : '普通用户' }} · {{ user.systemRole === 'admin' || user.canCreateProjects ? '可创建项目' : '不可创建项目' }}<br v-if="user.mustChangePassword" /><span v-if="user.mustChangePassword">需设置新密码</span></p><div class="auth-inline-actions"><button class="auth-link" :aria-label="`编辑账号 ${user.username}`" @click="open('edit', user)">编辑</button><button class="auth-link" :aria-label="`重置密码 ${user.username}`" :disabled="user.id === auth.user?.id || !user.active" @click="open('reset', user)">重置密码</button></div></article></div>
  </template>
  <div v-else-if="!pageError" class="auth-empty"><p>{{ users.length ? '没有匹配的账号，请调整搜索或筛选。' : '暂无账号记录，请刷新后重试。' }}</p><button v-if="users.length" class="auth-link" @click="query = ''; status = 'all'; creation = 'all'">清空筛选</button></div>
  <p class="auth-note">停用账号会撤销已有登录会话，保留任务和历史记录。初始密码由管理员自行交付，不自动发送通知。</p>

  <dialog v-if="mode" ref="dialog" class="auth-dialog" aria-labelledby="user-dialog-title" @cancel.prevent="close">
   <header class="auth-dialog-header"><h2 id="user-dialog-title">{{ title }}</h2><button class="auth-link" aria-label="关闭账号操作" :disabled="busy" @click="close">关闭</button></header>
   <form v-if="phase === 'form'" @submit.prevent="prepare"><div class="auth-dialog-body">
    <p v-if="error" class="auth-error" role="alert">{{ error }}</p><p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>
    <button v-if="recoveryNeeded" class="auth-button" type="button" :disabled="busy" @click="recover">读取最新账号状态</button>
    <label class="auth-field">姓名<input v-model="draft.name" autocomplete="off" required maxlength="80" :disabled="busy" /></label>
    <label class="auth-field">登录账号<input v-model="draft.username" autocomplete="off" required minlength="3" maxlength="48" pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,47}" :disabled="mode !== 'create' || busy" /><small>3–48 位英文字母、数字、点、下划线或短横线，以字母或数字开头；不区分大小写，开通后不可修改。</small></label>
    <label class="auth-field">系统角色<select v-model="draft.systemRole" :disabled="protectedAdmin || busy"><option value="user">普通用户</option><option value="admin">系统管理员</option></select><small v-if="protectedAdmin">不能停用或降级当前账号及最后一名系统管理员。</small><small v-else-if="draft.systemRole === 'admin'">系统管理员可管理全部账号与项目。</small></label>
    <label v-if="mode === 'edit'" class="auth-check"><input v-model="draft.active" type="checkbox" :disabled="protectedAdmin || busy" />允许登录</label>
    <label class="auth-check"><input v-model="draft.canCreateProjects" type="checkbox" :disabled="draft.systemRole === 'admin' || busy" />允许创建项目<span v-if="draft.systemRole === 'admin'">（管理员自动具备）</span></label>
    <p v-if="mode === 'create'" class="auth-notice">账号默认启用。开通成功后展示一次初始密码，用户首次登录必须修改密码。</p>
   </div><footer class="auth-dialog-footer"><button class="auth-button" type="button" :disabled="busy" @click="close">取消</button><button class="auth-button primary" :disabled="busy || recoveryNeeded || !draft.name.trim() || !draft.username.trim()">核对并继续</button></footer></form>
   <template v-else-if="phase === 'confirm'"><div class="auth-dialog-body">
    <p v-if="error" class="auth-error" role="alert">{{ error }}</p><p v-if="notice" class="auth-notice" role="status">{{ notice }}</p>
    <dl class="auth-facts"><div><dt>姓名</dt><dd>{{ mode === 'reset' ? selected?.name : draft.name }}</dd></div><div><dt>登录账号</dt><dd>{{ mode === 'reset' ? selected?.username : draft.username }}</dd></div><template v-if="mode !== 'reset'"><div><dt>系统角色</dt><dd>{{ draft.systemRole === 'admin' ? '系统管理员' : '普通用户' }}</dd></div><div><dt>登录状态</dt><dd>{{ draft.active ? '允许登录' : '停用账号' }}</dd></div><div><dt>创建项目</dt><dd>{{ draft.systemRole === 'admin' || draft.canCreateProjects ? '允许' : '不允许' }}</dd></div></template></dl>
    <p v-if="mode === 'reset'" class="auth-notice">重置后，此账号的所有会话立即退出。生成的初始密码只展示一次，用户再次登录必须设置新密码。</p>
    <p v-else-if="mode === 'edit' && !draft.active" class="auth-error">停用后，该账号无法登录，已有会话将退出；业务历史保留。</p>
    <p v-else-if="mode === 'create'" class="auth-notice">请确认账号及权限正确，再开通账号。</p>
    <p v-else class="auth-notice">保存后按新的账号状态与权限生效，请确认变更。</p>
    <button v-if="recoveryNeeded" class="auth-button" :disabled="busy" @click="recover">{{ busy ? '正在读取…' : '读取最新账号状态' }}</button>
   </div><footer class="auth-dialog-footer"><button class="auth-button" :disabled="busy" @click="mode === 'reset' ? close() : phase = 'form'">{{ mode === 'reset' ? '取消' : '返回修改' }}</button><button class="auth-button" :class="mode === 'reset' || !draft.active ? 'danger' : 'primary'" :disabled="busy || recoveryNeeded" @click="save">{{ busy ? '正在提交…' : mode === 'reset' ? '确认重置密码' : mode === 'create' ? '确认开通账号' : !draft.active ? '确认停用账号' : '确认保存修改' }}</button></footer></template>
   <template v-else-if="credential"><div class="auth-dialog-body"><p class="auth-notice">账号操作已完成。请将以下凭据交付给对应用户；关闭后不再显示，不能重新查看密码。</p><p v-if="error" class="auth-error" role="alert">{{ error }}</p><div class="auth-credential"><span>{{ credential.user.name }}</span><span>登录账号：<code>{{ credential.user.username }}</code></span><span>初始密码：<code data-testid="issued-password">{{ credential.initialPassword }}</code></span><button class="auth-button" @click="copyCredential">{{ copied ? '已复制凭据' : '复制登录凭据' }}</button></div><p class="auth-note">用户首次登录需设置新密码。此处不会自动发送邮件或消息。</p></div><footer class="auth-dialog-footer"><button class="auth-button primary" @click="clearDialog">已保存凭据，关闭</button></footer></template>
  </dialog>
 </section>
</template>
