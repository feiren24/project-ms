<script setup lang="ts">
import BrandLogo from '../../components/BrandLogo.vue';
import { onBeforeUnmount, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import type { AuthSession } from '../../../../shared/src/auth';
import { AuthError } from '../../api/auth';
import { useAuthStore } from '../../stores/auth';
import './auth.css';
const props = defineProps<{ force?: boolean }>();
const emit = defineEmits<{ saved: [session: AuthSession]; cancel: []; logout: [] }>();
const auth = useAuthStore(), currentPassword = ref(''), newPassword = ref(''), confirmation = ref(''), visible = ref(false), error = ref('');
const recoveryAvailable = ref(false), accountUsername = auth.user?.username || '', accountId = auth.user?.id || '';
let key = crypto.randomUUID();
watch([currentPassword, newPassword], () => { key = crypto.randomUUID(); error.value = ''; });
function confirmNavigation() { return !auth.loading && (!(currentPassword.value || newPassword.value || confirmation.value) || window.confirm('新密码尚未保存，离开将丢弃已填写的内容。是否离开？')); }
const removeGuard = useRouter().beforeEach((to, from) => to.fullPath === from.fullPath || confirmNavigation());
onBeforeUnmount(removeGuard);
defineExpose({ confirmNavigation });
async function submit() {
  if (auth.loading) return;
  if ([...newPassword.value].length < 12 || [...newPassword.value].length > 128) { error.value = '新密码需为 12–128 个字符。'; return; }
  if (newPassword.value !== confirmation.value) { error.value = '两次输入的新密码不一致，请重新核对。'; return; }
  if (newPassword.value === currentPassword.value) { error.value = '新密码不能与当前密码相同。'; return; }
  error.value = '';
  try { await auth.changePassword(currentPassword.value, newPassword.value, key, session => { currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; emit('saved', session); }); }
  catch (e) {
    error.value = e instanceof Error ? e.message : '修改失败，请重试。';
    recoveryAvailable.value = e instanceof AuthError && (e.status === 0 || e.status >= 500 || [401, 403, 409].includes(e.status));
  }
}
async function recoverLogin() {
  if (auth.loading || !newPassword.value) return;
  error.value = '';
  try {
    await auth.login(accountUsername, newPassword.value, session => {
      if (!session.user || session.user.id !== accountId || session.user.mustChangePassword) { error.value = '当前账号仍需设置新密码，请核对后重新提交。'; key = crypto.randomUUID(); return; }
      currentPassword.value = ''; newPassword.value = ''; confirmation.value = ''; recoveryAvailable.value = false; emit('saved', session);
    });
  } catch (e) { error.value = e instanceof Error ? `未能使用新密码登录：${e.message}` : '重新登录未完成，请核对密码后重试。'; }
}
</script>
<template>
  <section class="auth-page" aria-labelledby="password-title"><div class="auth-card">
    <div class="auth-brand"><BrandLogo size="large" subtitle="我有好活 · 账号安全" /></div>
    <h1 id="password-title">{{ force ? '设置新密码' : '修改密码' }}</h1>
    <p class="auth-intro">{{ force ? '首次登录或密码重置后，请先设置你自己的密码。' : '修改后，其他已登录的会话将退出。' }}</p>
    <p class="auth-password-help">当前账号：{{ auth.user?.username }} · 新密码为 12–128 个字符，支持中文及空格。</p>
    <form class="auth-form" style="margin-top:20px" @submit.prevent="submit">
      <p v-if="error" class="auth-error" role="alert">{{ error }}</p>
      <div v-if="recoveryAvailable" class="auth-notice">修改结果可能尚未确认。如果密码已更新，可以使用刚填写的新密码重新登录，核对是否成功。<button type="button" class="auth-link" :disabled="auth.loading || !newPassword" @click="recoverLogin">使用新密码重新登录</button></div>
      <label class="auth-field">{{ force ? '当前密码（初始密码）' : '当前密码' }}<input v-model="currentPassword" :type="visible ? 'text' : 'password'" autocomplete="current-password" required :disabled="auth.loading" autofocus /></label>
      <label class="auth-field">新密码<input v-model="newPassword" :type="visible ? 'text' : 'password'" autocomplete="new-password" required :disabled="auth.loading" /></label>
      <label class="auth-field">确认新密码<input v-model="confirmation" :type="visible ? 'text' : 'password'" autocomplete="new-password" required :disabled="auth.loading" /></label>
      <label class="auth-check"><input v-model="visible" type="checkbox" />显示密码</label>
      <button class="auth-button primary" :disabled="auth.loading">{{ auth.loading ? '正在保存…' : force ? '保存并进入工作空间' : '保存新密码' }}</button>
      <button v-if="!force" class="auth-button" type="button" :disabled="auth.loading" @click="confirmNavigation() && emit('cancel')">取消</button>
      <button v-else class="auth-button" type="button" :disabled="auth.loading" @click="emit('logout')">退出当前账号</button>
    </form>
  </div></section>
</template>
