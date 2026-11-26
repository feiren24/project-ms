<script setup lang="ts">
import BrandLogo from '../../components/BrandLogo.vue';
import { projectRoleLabels } from '../../../../shared/src/permissions';

import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '../../stores/auth';
import { useProjectsStore } from '../../stores/projects';
import './projects.css';
const emit = defineEmits<{ create: []; account: []; logout: [] }>();
const auth=useAuthStore(), projects=useProjectsStore(), router=useRouter(), query=ref('');
const filtered=computed(()=>projects.projects.filter(p=>`${p.name} ${p.goal}`.toLowerCase().includes(query.value.trim().toLowerCase())));
onMounted(()=>projects.load());
</script>
<template>
 <main class="projects-page">
  <header class="projects-account"><BrandLogo size="large" /><div><button class="button" @click="emit('account')">{{ auth.user?.name }} · 我的账号</button><button v-if="auth.user?.systemRole==='admin'" class="button" @click="router.push('/admin/users')">用户管理</button><button v-if="auth.user?.systemRole==='admin'" class="button" @click="router.push('/admin/settings')">系统设置</button><button class="button" @click="emit('logout')">退出登录</button></div></header>
  <section class="projects-heading"><div><span class="eyebrow">MY PROJECTS</span><h1>我的项目</h1><p>选择一个项目，继续任务与计划协作。</p></div><button v-if="projects.canCreate" class="button primary" @click="emit('create')">＋ 创建新项目</button></section>
  <div class="projects-tools"><input v-model="query" type="search" aria-label="搜索我的项目" placeholder="搜索项目名称或目标"/><button class="button" :disabled="projects.loading" @click="projects.load">{{ projects.loading ? '正在刷新…' : '刷新项目' }}</button></div>
  <p v-if="projects.error" class="project-error" role="alert">{{ projects.error }}<button class="project-text" @click="projects.load">重新读取</button></p>
  <p v-if="projects.loading && !projects.loaded" class="projects-empty" role="status">正在读取你的项目…</p>
  <div v-else-if="filtered.length" class="projects-grid"><button v-for="project in filtered" :key="project.id" class="project-card" :aria-label="`打开项目 ${project.name}`" @click="router.push({name:'overview',params:{projectId:project.id}})"><span class="project-card-meta"><span>{{ project.isDemo ? 'DEMO · 示例项目' : '项目工作空间' }}</span><span>{{ projectRoleLabels[project.role] }}</span></span><h2>{{ project.name }}</h2><p>{{ project.goal || '暂未填写项目目标' }}</p><footer><span>{{ project.start }} → {{ project.end }}</span><span>进入项目 ↗</span></footer></button></div>
  <section v-else-if="!projects.error" class="projects-empty"><h2>{{ query ? '没有匹配的项目' : '还没有可访问的项目' }}</h2><p>{{ query ? '尝试其他关键词，或清空搜索查看全部项目。' : projects.canCreate ? '可以从空白项目开始，填写目标和日期后再安排任务。' : '请联系项目负责人将你的账号加入项目。创建项目需管理员授权。' }}</p><button v-if="query" class="button" @click="query=''">清空搜索</button><button v-else-if="projects.canCreate" class="button primary" @click="emit('create')">创建第一个项目</button></section>
 </main>
</template>
