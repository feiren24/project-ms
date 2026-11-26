import { nextTick, onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue';

/** Measure the shell above the page, including collaboration banners. Scroll does not change its budget. */
export function usePlanViewport(page: Ref<HTMLElement | undefined>, fullscreen: Ref<boolean>) {
  const availableHeight = ref(window.innerHeight - 66);
  let resize: ResizeObserver | undefined, mutations: MutationObserver | undefined, frame = 0;
  const measure = () => {
    if (!page.value) return;
    const viewport = window.visualViewport?.height ?? window.innerHeight;
    const top = fullscreen.value ? 0 : page.value.getBoundingClientRect().top + window.scrollY;
    availableHeight.value = Math.max(240, Math.floor(viewport - top));
  };
  const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
  const observeShell = () => {
    resize?.disconnect();
    if (page.value) resize?.observe(page.value);
    document.querySelectorAll('.topbar, .collaboration-banner').forEach(el => resize?.observe(el));
    schedule();
  };
  onMounted(() => {
    resize = new ResizeObserver(schedule);
    observeShell();
    mutations = new MutationObserver(observeShell);
    if (page.value?.parentElement) mutations.observe(page.value.parentElement, { childList: true });
    window.addEventListener('resize', schedule);
    window.visualViewport?.addEventListener('resize', schedule);
  });
  watch(fullscreen, () => { void nextTick(schedule); });
  onBeforeUnmount(() => {
    resize?.disconnect(); mutations?.disconnect(); cancelAnimationFrame(frame);
    window.removeEventListener('resize', schedule);
    window.visualViewport?.removeEventListener('resize', schedule);
  });
  return { availableHeight };
}
