<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { useRoute, useRouter, isNavigationFailure } from 'vue-router';
import { useProjectsStore } from '../../stores/projects';
import './projects.css';
const props = defineProps<{ name: string; isDemo?: boolean }>();
const emit = defineEmits<{ create: [] }>();
const projects = useProjectsStore(), route = useRoute(), router = useRouter();
const open = ref(false), query = ref(''), element = ref<HTMLElement>();
const filtered = computed(() => projects.projects.filter(p => p.name.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
async function toggle() { open.value = !open.value; if (open.value) { query.value = ''; await projects.load(); } }
async function select(id: string) {
  if (id === route.params.projectId) { open.value = false; return; }
  const page = ['overview','plan','workstreams','tasks','analytics','risks','settings'].includes(String(route.name)) ? route.name : route.name === 'task-detail' ? 'tasks' : route.name === 'risk-detail' ? 'risks' : 'overview';
  const result = await router.push({ name: page!, params: { projectId: id }, query: {} });
  if (!isNavigationFailure(result)) open.value = false;
}
function outside(event: PointerEvent) { if (!element.value?.contains(event.target as Node)) open.value = false; }
document.addEventListener('pointerdown', outside);
onBeforeUnmount(() => document.removeEventListener('pointerdown', outside));
</script>
<template>
 <div ref="element" class="project-picker" @keydown.esc.stop="open=false">
  <button class="project-switch" aria-label="切换项目" :aria-expanded="open" aria-controls="project-switch-panel" @click="toggle"><span>{{ props.name }}</span><span v-if="props.isDemo" class="demo-label">DEMO · 示例项目</span><span aria-hidden="true">⌄</span></button>
  <section v-if="open" id="project-switch-panel" class="project-picker-panel" aria-label="项目切换列表">
   <label class="project-search"><span class="sr-only">搜索项目</span><input v-model="query" type="search" placeholder="搜索项目" aria-label="搜索项目"/></label>
   <p v-if="projects.loading" class="project-picker-note" role="status">正在读取项目…</p>
   <p v-if="projects.error" class="project-picker-note" role="alert">{{ projects.error }}<button class="project-text" @click="projects.load">重试</button></p>
   <div class="project-picker-list"><button v-for="project in filtered" :key="project.id" :aria-current="project.id===route.params.projectId ? 'true' : undefined" :class="{ selected: project.id===route.params.projectId }" @click="select(project.id)"><span>{{ project.name }}<small>{{ project.isDemo ? 'DEMO · 示例项目' : '项目工作空间' }}</small></span><span v-if="project.id===route.params.projectId" aria-label="当前项目">✓</span></button></div>
   <p v-if="!projects.loading && !projects.error && !filtered.length" class="project-picker-note">{{ query ? '没有匹配的项目，请调整搜索。' : '还没有可访问的项目。' }}</p>
   <footer><button class="project-text" @click="router.push('/workspace');open=false">查看所有项目</button><button v-if="projects.canCreate" class="project-text" @click="open=false;emit('create')">＋ 创建新项目</button><small v-else>创建项目需管理员授权</small></footer>
  </section>
 </div>
</template>
