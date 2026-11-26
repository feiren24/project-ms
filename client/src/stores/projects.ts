import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { useAuthStore } from './auth';
import { fetchProjects } from '../api/projects';
import type { ProjectInfo } from '../../../shared/src/projects';
export const useProjectsStore = defineStore('projects', () => {
  const auth = useAuthStore(), projects = ref<ProjectInfo[]>([]), loading = ref(false), loaded = ref(false), error = ref('');
  const creationAllowed = ref<boolean | null>(null);
  const canCreate = computed(() => !!auth.user && (creationAllowed.value ?? (auth.user.systemRole === 'admin' || auth.user.canCreateProjects)));
  let sequence = 0;
  async function load() {
    const request = ++sequence, permissionRevision = auth.directoryRevision, userId = auth.user?.id; loading.value = true; error.value = '';
    try {
      const result = await fetchProjects();
      if (request !== sequence || permissionRevision !== auth.directoryRevision || userId !== auth.user?.id) return;
      projects.value = result.projects; creationAllowed.value = result.canCreate; loaded.value = true;
      if (auth.session) auth.session.projects = result.projects.map(project => sessionEntry(project));
    } catch (e) { if (request === sequence) error.value = e instanceof Error ? e.message : '项目列表读取失败，请重试。'; }
    finally { if (request === sequence) loading.value = false; }
  }
  function sessionEntry(project: ProjectInfo) {
    const previous = auth.session?.projects.find(p => p.id === project.id);
    const supplied = (project as ProjectInfo & { capabilities?: import('../utils/module-privacy').ModuleCapabilities }).capabilities;
    const capabilities = supplied || (previous?.role === project.role ? previous?.capabilities : undefined);
    return { id: project.id, name: project.name, memberId: project.memberId, role: project.role, capabilities };
  }
  function upsert(project: ProjectInfo) {
    const index = projects.value.findIndex(item => item.id === project.id);
    if (index < 0) projects.value.push(project); else projects.value[index] = project;
    if (auth.session) {
      const entry = sessionEntry(project);
      const found = auth.session.projects.findIndex(item => item.id === project.id);
      if (found < 0) auth.session.projects.push(entry); else auth.session.projects[found] = entry;
    }
  }
  return { projects, loading, loaded, error, canCreate, load, upsert };
});
