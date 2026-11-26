import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch, type Ref } from 'vue';
import { useRouter } from 'vue-router';
import type { PlanNode, PlanSiblingOrder, ProjectPlan } from '../../../../shared/src/planning';
import { orderPlanNodes } from '../../../../shared/src/plan-order';
import { PlanningError, savePlanOrder } from '../../api/planning';

interface OrderView { query: string; owner: string; status: string; workstream: string; mobileView: string; collapsed: string[] }
const copyOrders = (orders: PlanSiblingOrder[]) => orders.map(order => ({ parentId: order.parentId, nodeIds: [...order.nodeIds] }));

/** A local order draft never replaces the authoritative schedule or other users' edits. */
export function usePlanOrder(plan: Ref<ProjectPlan | null>, canManage: Ref<boolean>, view: OrderView, options: {
  mobile: Ref<boolean>; actorId: () => string; readLatest: () => Promise<ProjectPlan>; notify: (message: string) => void;
  locate: (id: string) => void; changed: () => void;
}) {
  const active = ref(false), busy = ref(false), selectedId = ref(''), error = ref('');
  const base = ref<ProjectPlan | null>(null), draft = ref<PlanSiblingOrder[]>([]);
  const filterPrompt = ref(false), discardPrompt = ref(false), positionOpen = ref(false), compareOpen = ref(false);
  const stale = ref(false), forbidden = ref(false), latest = ref<ProjectPlan | null>(null);
  const reference = ref<{ nodes: PlanNode[]; orders: PlanSiblingOrder[] } | null>(null);
  let previousView: Pick<OrderView, 'query' | 'owner' | 'status' | 'mobileView' | 'collapsed'> | undefined;
  let disposed = false, attempt = { body: '', key: '' };
  const nodes = computed(() => orderPlanNodes((active.value ? base.value : plan.value)?.nodes ?? [], active.value ? draft.value : plan.value?.siblingOrders ?? []));
  const byId = computed(() => new Map(nodes.value.map(node => [node.id, node])));
  const selected = computed(() => byId.value.get(selectedId.value) ?? null);
  const siblings = computed(() => draft.value.find(group => group.parentId === selected.value?.parentId)?.nodeIds ?? []);
  const selectedIndex = computed(() => siblings.value.indexOf(selectedId.value));
  const changes = computed(() => {
    const original = new Map(base.value?.siblingOrders.map(group => [group.parentId, group.nodeIds.join('\0')]) ?? []);
    return draft.value.filter(group => group.nodeIds.join('\0') !== original.get(group.parentId));
  });
  const dirty = computed(() => active.value && changes.value.length > 0);
  const locked = computed(() => busy.value || stale.value || forbidden.value || !canManage.value);
  const canUp = computed(() => !locked.value && selectedIndex.value > 0);
  const canDown = computed(() => !locked.value && selectedIndex.value >= 0 && selectedIndex.value < siblings.value.length - 1);
  const canPosition = computed(() => !locked.value && selectedIndex.value >= 0 && siblings.value.length > 1);
  const descendants = computed(() => {
    if (!selected.value) return 0;
    const children = new Map<string, string[]>();
    for (const node of nodes.value) if (node.parentId) { const list = children.get(node.parentId) ?? []; list.push(node.id); children.set(node.parentId, list); }
    const seen = new Set<string>(), stack = [...(children.get(selected.value.id) ?? [])];
    while (stack.length) { const id = stack.pop()!; if (seen.has(id)) continue; seen.add(id); stack.push(...children.get(id) ?? []); }
    return seen.size;
  });
  function begin() {
    if (!plan.value || !canManage.value || active.value) return;
    previousView = { query: view.query, owner: view.owner, status: view.status, mobileView: view.mobileView, collapsed: [...view.collapsed] };
    base.value = structuredClone(JSON.parse(JSON.stringify(plan.value)));
    draft.value = copyOrders(base.value!.siblingOrders);
    active.value = true; error.value = ''; stale.value = false; forbidden.value = false; selectedId.value = '';
    view.query = ''; view.owner = ''; view.status = '';
    if (options.mobile.value) view.mobileView = 'list';
    filterPrompt.value = false;
  }
  function requestBegin() {
    if (view.query.trim() || view.owner || view.status) filterPrompt.value = true;
    else begin();
  }
  async function finish() {
    active.value = false; positionOpen.value = false; compareOpen.value = false; discardPrompt.value = false;
    error.value = ''; reference.value = null; latest.value = null; attempt = { body: '', key: '' };
    if (previousView) {
      const collapsed = previousView.collapsed;
      Object.assign(view, previousView);
      await nextTick(); view.collapsed = collapsed;
    }
  }
  function cancel() { if (busy.value) return; if (dirty.value) discardPrompt.value = true; else void finish(); }
  function select(node: PlanNode) { if (!busy.value && node.parentId) selectedId.value = node.id; }
  function move(id: string, targetId: string, placement: 'before' | 'after') {
    if (!active.value || locked.value || id === targetId) return;
    const node = byId.value.get(id), target = byId.value.get(targetId);
    if (!node?.parentId || node.parentId !== target?.parentId) return;
    const group = draft.value.find(order => order.parentId === node.parentId);
    if (!group || !group.nodeIds.includes(id) || !group.nodeIds.includes(targetId)) return;
    const ids = group.nodeIds.filter(candidate => candidate !== id);
    ids.splice(ids.indexOf(targetId) + Number(placement === 'after'), 0, id);
    group.nodeIds = ids; selectedId.value = id; error.value = '';
    void nextTick(() => options.locate(id));
  }
  function step(direction: 'up' | 'down') {
    const target = siblings.value[selectedIndex.value + (direction === 'up' ? -1 : 1)];
    if (target) move(selectedId.value, target, direction === 'up' ? 'before' : 'after');
  }
  async function save() {
    if (!base.value || !dirty.value || locked.value) return;
    const body = { expectedOrderVersion: base.value.orderVersion, orders: copyOrders(changes.value) };
    const fingerprint = JSON.stringify(body);
    if (attempt.body !== fingerprint) attempt = { body: fingerprint, key: crypto.randomUUID() };
    busy.value = true; error.value = '';
    try {
      await savePlanOrder(base.value, body, attempt.key, options.actorId());
      const result = await options.readLatest();
      if (disposed) return;
      plan.value = result;
      await finish();
      options.changed(); options.notify('顺序已保存，对当前项目成员生效。');
      await nextTick(); options.locate(selectedId.value);
    } catch (e) {
      if (disposed) return;
      error.value = e instanceof Error ? e.message : '保存失败，调整草稿已保留，请重试。';
      stale.value = e instanceof PlanningError && e.status === 409;
      forbidden.value = e instanceof PlanningError && [401, 403, 404].includes(e.status);
    } finally { if (!disposed) busy.value = false; }
  }
  async function compare() {
    if (busy.value) return;
    busy.value = true;
    try { const result = await options.readLatest(); if (disposed) return; latest.value = result; if (canManage.value) forbidden.value = false; compareOpen.value = true; }
    catch (e) { if (!disposed) error.value = e instanceof Error ? e.message : '读取最新顺序失败，请重试。'; }
    finally { if (!disposed) busy.value = false; }
  }
  function restart() {
    if (!latest.value || !canManage.value) return;
    reference.value = { nodes: base.value!.nodes, orders: copyOrders(changes.value) };
    plan.value = latest.value; base.value = latest.value; draft.value = copyOrders(latest.value.siblingOrders);
    stale.value = false; forbidden.value = false; compareOpen.value = false; error.value = ''; selectedId.value = '';
    attempt = { body: '', key: '' };
  }
  function confirmNavigation() {
    if (busy.value) { options.notify('正在保存顺序，请稍候。'); return false; }
    if (dirty.value && !window.confirm('顺序调整尚未保存，离开将放弃这些调整。是否离开？')) return false;
    if (active.value) void finish();
    return true;
  }
  watch(options.mobile, mobile => { if (mobile && active.value) view.mobileView = 'list'; });
  const removeGuard = useRouter().beforeEach((to, from) => to.name === from.name && to.params.projectId === from.params.projectId ? true : confirmNavigation());
  const protectUnload = (event: BeforeUnloadEvent) => { if (dirty.value || busy.value) { event.preventDefault(); event.returnValue = ''; } };
  onMounted(() => window.addEventListener('beforeunload', protectUnload));
  onBeforeUnmount(() => { disposed = true; removeGuard(); window.removeEventListener('beforeunload', protectUnload); });
  return reactive({ active, busy, selectedId, selected, descendants, nodes, draft, base, error, filterPrompt, discardPrompt, positionOpen,
    compareOpen, reference, latest, stale, forbidden, locked, dirty, canUp, canDown, canPosition, siblings, changes,
    requestBegin, begin, finish, cancel, select, move, step, save, compare, restart });
}
export type PlanOrderController = ReturnType<typeof usePlanOrder>;
