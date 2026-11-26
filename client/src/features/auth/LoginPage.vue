<script setup lang="ts">
import BrandLogo from '../../components/BrandLogo.vue';
import { computed, ref } from 'vue';
import type { AuthSession } from '../../../../shared/src/auth';
import { useAuthStore } from '../../stores/auth';
import './auth.css';
const props = defineProps<{ reauth?: boolean }>();
const emit = defineEmits<{ authenticated: [session: AuthSession] }>();
const auth = useAuthStore(), username = ref(props.reauth ? auth.user?.username || '' : ''), password = ref(''), visible = ref(false), localError = ref('');
const initialized = computed(() => auth.session?.initialized !== false);
async function submit() {
  if (auth.loading) return;
  localError.value = '';
  try { await auth.login(username.value.trim(), password.value, session => { password.value = ''; emit('authenticated', session); }); }
  catch (e) { localError.value = e instanceof Error ? e.message : '登录失败，请重试。'; }
}
async function checkInitialization() { localError.value = ''; try { await auth.load(); } catch (e) { localError.value = e instanceof Error ? e.message : '检查失败，请重试。'; } }
</script>
<template>
  <section class="auth-page" aria-labelledby="login-title">
    <div class="auth-card">
      <div class="auth-brand"><BrandLogo size="large" subtitle="我有好活 · 项目管理" /></div>
      <h1 id="login-title">{{ reauth ? '请重新登录' : '欢迎回来' }}</h1>
      <p class="auth-intro">{{ reauth ? '登录已过期。使用同一账号重新登录，可继续处理当前草稿。' : '登录后继续项目协作。' }}</p>
      <p v-if="localError" class="auth-error" role="alert">{{ localError }}</p>
      <div v-if="!initialized" class="auth-notice" role="status">工作空间尚未启用。请联系管理员完成初始化后，再使用分配给你的账号登录。<button class="auth-link" :disabled="auth.loading" @click="checkInitialization">{{ auth.loading ? '正在检查…' : '重新检查' }}</button></div>
      <form v-else class="auth-form" @submit.prevent="submit">
        <label class="auth-field">登录账号<input v-model="username" name="username" autocomplete="username" required maxlength="48" :disabled="auth.loading" autofocus /></label>
        <label class="auth-field">密码<span class="auth-password"><input v-model="password" name="password" aria-label="密码" :type="visible ? 'text' : 'password'" autocomplete="current-password" required :disabled="auth.loading" /><button type="button" :aria-label="visible ? '隐藏密码' : '显示密码'" :aria-pressed="visible" @click="visible = !visible">{{ visible ? '隐藏' : '显示' }}</button></span></label>
        <button class="auth-button primary" :disabled="auth.loading || !username.trim() || !password">{{ auth.loading ? '正在登录…' : '登录' }}</button>
      </form>
      <p class="auth-note">无账号或忘记密码？请联系管理员。</p>
      <p v-if="reauth" class="auth-note">使用其他账号登录将清理当前账号的页面与草稿。</p>
    </div>
  </section>
</template>
