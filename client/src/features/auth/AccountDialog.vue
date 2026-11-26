<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
import { useAuthStore } from '../../stores/auth';
import './auth.css';
const emit = defineEmits<{ close: []; 'change-password': [] }>();
const auth = useAuthStore(), dialog = ref<HTMLDialogElement>();
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => dialog.value?.close());
</script>
<template>
 <dialog ref="dialog" class="auth-dialog" aria-labelledby="account-title" @cancel.prevent="emit('close')">
  <header class="auth-dialog-header"><h2 id="account-title">我的账号</h2><button class="auth-link" aria-label="关闭我的账号" @click="emit('close')">关闭</button></header>
  <div class="auth-dialog-body"><dl class="auth-facts"><div><dt>姓名</dt><dd>{{ auth.user?.name }}</dd></div><div><dt>登录账号</dt><dd>{{ auth.user?.username }}</dd></div><div><dt>系统角色</dt><dd>{{ auth.user?.systemRole === 'admin' ? '系统管理员' : '普通用户' }}</dd></div><div><dt>创建项目</dt><dd>{{ auth.user?.systemRole === 'admin' || auth.user?.canCreateProjects ? '已授权' : '未授权' }}</dd></div></dl><p class="auth-notice">项目中的角色由项目负责人分配。需要修改姓名或账号权限，请联系管理员。</p></div>
  <footer class="auth-dialog-footer"><button class="auth-button" @click="emit('close')">关闭</button><button class="auth-button primary" @click="emit('change-password')">修改密码</button></footer>
 </dialog>
</template>
