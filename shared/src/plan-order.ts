import type { PlanNode, PlanSiblingOrder } from './planning.js';
export type { PlanSiblingOrder, PlanOrderRequest, PlanOrderResult } from './planning.js';

/** Canonical preorder, without sorting or mutating scheduling inputs. O(nodes + references).
 * Stale/duplicate references are ignored; orphaned/cyclic nodes remain reachable once. */
export function orderPlanNodes(nodes: PlanNode[], orders: PlanSiblingOrder[]): PlanNode[] {
  const byId = new Map<string, PlanNode>();
  for (const node of nodes) if (!byId.has(node.id)) byId.set(node.id, node);
  const children = new Map<string, PlanNode[]>();
  for (const node of byId.values()) if (node.parentId !== null) {
    const list = children.get(node.parentId) ?? []; list.push(node); children.set(node.parentId, list);
  }
  const handled = new Set<string>();
  for (const order of orders) {
    if (!order || handled.has(order.parentId) || !Array.isArray(order.nodeIds)) continue;
    handled.add(order.parentId);
    const siblings = children.get(order.parentId); if (!siblings) continue;
    const seen = new Set<string>(), sorted: PlanNode[] = [];
    for (const id of order.nodeIds) { const node = byId.get(id); if (node?.parentId === order.parentId && !seen.has(id)) { seen.add(id); sorted.push(node); } }
    for (const node of siblings) if (!seen.has(node.id)) sorted.push(node);
    children.set(order.parentId, sorted);
  }
  const result: PlanNode[] = [], visited = new Set<string>();
  const visit = (root: PlanNode) => {
    const stack = [root];
    while (stack.length) {
      const node = stack.pop()!; if (visited.has(node.id)) continue;
      visited.add(node.id); result.push(node);
      const list = children.get(node.id) ?? [];
      for (let i = list.length - 1; i >= 0; i--) if (!visited.has(list[i]!.id)) stack.push(list[i]!);
    }
  };
  for (const node of byId.values()) if (node.parentId === null || !byId.has(node.parentId)) visit(node);
  for (const node of byId.values()) visit(node);
  return result;
}
