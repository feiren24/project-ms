import { computed, nextTick, onBeforeUnmount, provide, ref, watch, type ComputedRef, type InjectionKey } from 'vue';
import { isNavigationFailure, useRoute, useRouter } from 'vue-router';

export interface SearchState { query: string; scrollTop: number; selectedTaskId: string }
export const emptySearchState = (): SearchState => ({ query: '', scrollTop: 0, selectedTaskId: '' });
export const searchReturnKey: InjectionKey<{ active: ComputedRef<boolean>; close: () => Promise<void> }> = Symbol('search-return');

interface PagePosition { x: number; y: number; regions: Array<{ selector: string; x: number; y: number }> }
function capturePosition(): PagePosition {
  const root = document.getElementById('main-content');
  const regions: PagePosition['regions'] = [];
  for (const element of root?.querySelectorAll<HTMLElement>('*') ?? []) {
    if (!element.scrollTop && !element.scrollLeft) continue;
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== root) {
      const parent: Element | null = node.parentElement;
      if (!parent) break;
      parts.unshift(`${node.tagName.toLowerCase()}:nth-child(${Array.from(parent.children).indexOf(node) + 1})`);
      node = parent;
    }
    regions.push({ selector: `#main-content > ${parts.join(' > ')}`, x: element.scrollLeft, y: element.scrollTop });
  }
  return { x: window.scrollX, y: window.scrollY, regions };
}

// Pages load asynchronously. Reapply their captured scroll positions as their content arrives.
function restorePosition(position: PagePosition) {
  const restore = () => {
    window.scrollTo({ left: position.x, top: position.y, behavior: 'instant' });
    for (const item of position.regions) document.querySelector(item.selector)?.scrollTo({ left: item.x, top: item.y, behavior: 'instant' });
  };
  let frame = 0;
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(restore); };
  const observer = new MutationObserver(schedule);
  const main = document.getElementById('main-content');
  if (main) observer.observe(main, { childList: true, subtree: true });
  schedule();
  return () => { observer.disconnect(); cancelAnimationFrame(frame); };
}

export function useSearchNavigation(options: {
  projectId: string; account: () => string;
  show: () => void; hide: () => void;
  refresh: () => Promise<void>; notify: (message: string) => void;
}) {
  const router = useRouter(), route = useRoute();
  const state = ref<SearchState>(emptySearchState());
  const busy = ref(false);
  const session = ref<{ id: string; origin: string; position: PagePosition } | null>(null);
  let stopRestore: (() => void) | undefined;
  const active = computed(() => Boolean(session.value && route.params.projectId === options.projectId && route.query.from === 'search' && route.query.searchSession === session.value.id));
  function reset() { stopRestore?.(); session.value = null; state.value = emptySearchState(); }
  watch(options.account, reset);
  async function openTask(id: string) {
    if (busy.value) return;
    busy.value = true;
    stopRestore?.();
    const previous = session.value;
    const next = { id: crypto.randomUUID(), origin: route.fullPath, position: capturePosition() };
    session.value = next;
    state.value.selectedTaskId = id;
    try {
      const failure = await router.push({ name: 'task-detail', params: { projectId: options.projectId, taskId: id }, query: { from: 'search', searchSession: next.id } });
      if (isNavigationFailure(failure)) session.value = previous;
      else options.hide();
    } catch {
      session.value = previous;
      options.notify('暂时无法打开任务，请重试。');
    } finally { busy.value = false; }
  }
  async function close() {
    if (!active.value || !session.value) return;
    // Related-task switches replace the detail entry, so Back always reaches the source.
    if (window.history.state.back === session.value.origin) {
      await new Promise<void>(resolve => {
        const remove = router.afterEach(() => { remove(); resolve(); });
        router.back();
      });
    }
    else await router.replace(session.value.origin);
  }
  provide(searchReturnKey, { active, close });
  const removeHook = router.afterEach(async (to, from, failure) => {
    if (failure) return;
    const saved = session.value;
    if (!saved) return;
    if (to.params.projectId !== options.projectId) { reset(); return; }
    if (to.fullPath === saved.origin && from.query.searchSession === saved.id) {
      await nextTick();
      if (session.value !== saved || route.fullPath !== saved.origin) return;
      stopRestore?.(); stopRestore = restorePosition(saved.position);
      options.show();
      void options.refresh();
    } else if (to.query.searchSession === saved.id) {
      stopRestore?.(); options.hide();
    } else { reset(); }
  });
  onBeforeUnmount(() => { removeHook(); reset(); });
  return { state, busy, openTask, reset };
}
