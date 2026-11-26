import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import type { AuthSession } from '../../../shared/src/auth';
import * as api from '../api/auth';
import { projectCapabilities, type ModuleCapabilities } from '../utils/module-privacy';
import { clearProjectViews } from './project-scope';

export const useAuthStore = defineStore('auth', () => {
  const session = ref<AuthSession | null>(null), loading = ref(false), error = ref(''), reauthRequired = ref(false);
  const user = computed(() => session.value?.user ?? null);
  // Only identity changes invalidate every workspace. Directory/session snapshots
  // contain all memberships, while project reads and editors have a narrower scope.
  const privacyRevision = ref(0), directoryRevision = ref(0);
  const projectRevisions = ref<Record<string, number>>({});
  const projectPrivacyKey = (id: string) => `${privacyRevision.value}:${projectRevisions.value[id] || 0}`;
  const capabilities = (projectId: string) => projectCapabilities(session.value, projectId);
  function updateCapabilities(projectId: string, value: ModuleCapabilities) {
    const project = session.value?.projects.find(p => p.id === projectId);
    if (project) Object.assign(project, { capabilities: value });
  }
  watch(() => ({ user: session.value?.user?.id, projects: Object.fromEntries((session.value?.projects || []).map(p => [p.id, capabilities(p.id)])) }), (current, previous) => {
    if (!previous) return;
    if (previous.user && previous.user !== current.user) {
      clearProjectViews(); privacyRevision.value++; directoryRevision.value++;
      return;
    }
    const affected = Object.entries(previous.projects).filter(([id, before]) =>
      !current.projects[id] || (Object.keys(before) as Array<keyof ModuleCapabilities>).some(key => before[key] && !current.projects[id][key])).map(([id]) => id);
    if (affected.length) {
      clearProjectViews(affected);
      for (const id of affected) projectRevisions.value[id] = (projectRevisions.value[id] || 0) + 1;
      directoryRevision.value++;
    }
  }, { flush: 'sync' });
  let sequence = 0;
  async function perform(action: () => Promise<AuthSession>, onSuccess?: (value: AuthSession) => void) {
    const current = ++sequence, permissionRevision = directoryRevision.value; loading.value = true; error.value = '';
    try {
      const value = await action();
      if (current === sequence && permissionRevision === directoryRevision.value) {
        session.value = value;
        // Auth shells can unmount the submitting form as soon as the session changes.
        // Deliver its navigation/cleanup event before Vue flushes that unmount.
        onSuccess?.(value);
      }
      return value;
    } catch (e) { if (current === sequence) error.value = e instanceof Error ? e.message : '操作失败，请重试。'; throw e; }
    finally { if (current === sequence) loading.value = false; }
  }
  const load = () => perform(api.fetchSession);
  const refreshForRecovery = () => perform(async () => {
    const expectedId = user.value?.id;
    const value = await api.fetchSession();
    if (expectedId && (!value.user || value.user.id !== expectedId || value.user.mustChangePassword)) {
      // Keep the old editor mounted until an explicit login confirms its owner.
      if (user.value?.id === expectedId) reauthRequired.value = true;
      throw new api.AuthError('登录状态已变化，请重新登录后继续核对。当前填写内容已保留。', 401, 'AUTH_REQUIRED');
    }
    return value;
  });
  const login = (username: string, password: string, onSuccess?: (value: AuthSession) => void) => perform(() => api.login(username, password), onSuccess);
  const logout = async () => { const value = await perform(() => api.logout(session.value?.csrfToken || '')); reauthRequired.value = false; return value; };
  const changePassword = (currentPassword: string, newPassword: string, key = crypto.randomUUID(), onSuccess?: (value: AuthSession) => void) => perform(() => api.changePassword(session.value?.csrfToken || '', currentPassword, newPassword, key), onSuccess);
  function markExpired() { reauthRequired.value = true; }
  function actorForProject(projectId: string) { return session.value?.projects.find(p => p.id === projectId)?.memberId || ''; }
  return { privacyRevision, directoryRevision, projectPrivacyKey, capabilities, updateCapabilities, session, user, loading, error, reauthRequired, load, refreshForRecovery, login, logout, changePassword, markExpired, actorForProject };
});
