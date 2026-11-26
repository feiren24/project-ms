import { useAuthStore } from './auth';
import { ref, watch } from 'vue';
import type { TaskActor } from '../../../shared/src/tasks';
import { fetchProjectRevision } from '../api/notifications';
import { fetchSettings } from '../api/settings';
import { PlanningError } from '../api/planning';
// The auth shell supplies the real recipient; isolated legacy tests may select an actor.
const actorId = ref('zhou'), actors = ref<TaskActor[]>([]), unread = ref(0), pending = ref(false), error = ref(''), revision = ref(''), checking = ref(false);
let scope = '';
let acknowledged = '', sequence = 0, controller: AbortController | undefined;
let timer: ReturnType<typeof setInterval> | undefined, started = false;
async function check() {
  const requestActor = actorId.value, requestSequence = ++sequence;
  controller?.abort(); controller = new AbortController(); checking.value = true;
  try {
    const result = await fetchProjectRevision(requestActor, controller.signal);
    if (requestSequence !== sequence || requestActor !== actorId.value) return;
    if (result.actorId !== requestActor) throw new Error('通知收件人与当前账号不一致，请重新读取。');
    const auth = useAuthStore();
    if (!auth.session?.legacyDemo) {
      const project = auth.session?.projects.find(p => p.id === scope && p.memberId === result.actorId);
      const actor = result.actors.find(a => a.id === result.actorId);
      const capabilities = result.capabilities;
      if (capabilities) {
        if (project && actor) Object.assign(project, { role: actor.role, capabilities });
        else auth.updateCapabilities(scope, capabilities);
      } else {
        await auth.refreshForRecovery();
        if (requestSequence !== sequence || requestActor !== actorId.value) return;
      }
    }
    actors.value = result.actors; unread.value = result.unread; revision.value = result.revision; error.value = '';
    if (!acknowledged) acknowledged = result.revision;
    pending.value = result.revision !== acknowledged;
  } catch (e) {
    if (requestSequence !== sequence || requestActor !== actorId.value || (e as Error).name === 'AbortError') return;
    const invalid = e instanceof PlanningError && e.status === 403;
    if (invalid) unread.value = 0;
    error.value = invalid ? '当前通知身份已停用或不可用，请检查账号与项目权限。' : e instanceof Error ? e.message : '项目更新检查失败，请重试。';
    if (invalid && useAuthStore().session?.legacyDemo) try { const settings = await fetchSettings(); if (requestSequence === sequence && requestActor === actorId.value) actors.value = settings.actors; } catch { /* Keep the explicit access error and offer another read. */ }
  } finally { if (requestSequence === sequence) checking.value = false; }
}
function acknowledge(value = revision.value) {
  if (!value) return;
  acknowledged = value;
  pending.value = Boolean(revision.value && revision.value !== acknowledged);
}
const foregroundCheck = () => { if (document.visibilityState === 'visible') void check(); };
function start() {
  if (started) return;
  started = true; foregroundCheck();
  timer = setInterval(foregroundCheck, 30_000);
  window.addEventListener('focus', foregroundCheck); document.addEventListener('visibilitychange', foregroundCheck);
}
function stop() {
  started = false; if (timer) clearInterval(timer); timer = undefined;
  window.removeEventListener('focus', foregroundCheck); document.removeEventListener('visibilitychange', foregroundCheck);
  sequence++; controller?.abort(); checking.value = false;
}
watch(actorId, () => {
  sequence++; controller?.abort(); unread.value = 0; error.value = ''; checking.value = false;
  if (started && document.visibilityState === 'visible') void check();
}, { flush: 'sync' });
function updateUnread(value: { actorId: string; unread: number; actors: TaskActor[] }) {
  if (value.actorId !== actorId.value) return;
  // Invalidate a poll started before this read-state mutation, so its old count cannot win.
  sequence++; controller?.abort(); checking.value = false;
  unread.value = value.unread; actors.value = value.actors;
}
function setScope(projectId: string) { if (scope === projectId) return; stop(); scope = projectId; acknowledged = ''; unread.value = 0; pending.value = false; error.value = ''; revision.value = ''; actors.value = []; }
export function useProjectRefresh() { return { actorId, actors, unread, pending, error, revision, checking, check, start, stop, setScope, acknowledge, updateUnread }; }
