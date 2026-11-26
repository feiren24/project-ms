import type { PlanNode } from '../../../../shared/src/planning';

export interface PlanTreeMeta {
  depth: number;
  /** Vertical guides for ancestors other than the workstream root. */
  guides: boolean[];
  last: boolean;
  startsChildren: boolean;
  subtreeEnd: boolean;
  isParent: boolean;
  childCount: number;
  matchingChildCount: number;
  contextOnly: boolean;
  parentTitle: string;
  parentIsTask: boolean;
  path: string;
  caption: string;
}

/** One shared preorder for the canvas and mobile list. Compute before viewport/page clipping.
 * Inputs already carry the current saved or draft sibling order; WBS never determines ancestry. */
export function buildPlanTree(nodes: PlanNode[], matchingIds: Set<string>, collapsedIds: string[], filtered = false) {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const children = new Map<string, PlanNode[]>();
  for (const node of nodes) if (node.parentId) {
    const list = children.get(node.parentId) ?? [];
    list.push(node); children.set(node.parentId, list);
  }
  const included = new Set(matchingIds);
  for (const id of matchingIds) {
    let parent = byId.get(id)?.parentId;
    const seen = new Set<string>();
    while (parent && !seen.has(parent)) {
      seen.add(parent); included.add(parent); parent = byId.get(parent)?.parentId;
    }
  }
  const eligible = new Map([...children].map(([id, list]) => [id, list.filter(node => included.has(node.id))]));
  const rows: PlanNode[] = [], meta = new Map<string, PlanTreeMeta>();
  const collapsed = new Set(collapsedIds), visited = new Set<string>();
  type Frame = { node: PlanNode; depth: number; guides: boolean[]; last: boolean; path: string } | { end: true };
  const roots = nodes.filter(node => node.kind === 'group' && !node.parentId && included.has(node.id));
  const stack: Frame[] = roots.map((node, index) => ({ node, depth: 0, guides: [], last: index === roots.length - 1, path: node.title })).reverse();
  while (stack.length) {
    const frame = stack.pop()!;
    if ('end' in frame) {
      const lastRow = rows.at(-1);
      if (lastRow) meta.get(lastRow.id)!.subtreeEnd = true;
      continue;
    }
    const { node, depth, guides, last, path } = frame;
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    const direct = children.get(node.id) ?? [], matchingChildren = eligible.get(node.id) ?? [];
    const isParent = !!node.parentId && (node.kind === 'group' || node.taskKind === 'summary');
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const contextOnly = filtered && !matchingIds.has(node.id);
    const count = filtered ? `筛选 ${matchingChildren.length} / 共 ${direct.length}` : `${direct.length}`;
    const caption = node.kind === 'group' || isParent
      ? `${isParent ? '父任务' : '工作分组'} · ${count}项${isParent ? '子任务' : '计划'}${contextOnly ? ' · 仅展示层级' : ''}`
      : '';
    meta.set(node.id, { depth, guides, last, path, isParent, contextOnly, childCount: direct.length,
      matchingChildCount: matchingChildren.length, startsChildren: !collapsed.has(node.id) && matchingChildren.length > 0,
      subtreeEnd: false, parentTitle: parent?.title ?? '', parentIsTask: !!parent?.parentId && (parent.kind === 'group' || parent.taskKind === 'summary'), caption });
    rows.push(node);
    if (isParent) stack.push({ end: true });
    if (!collapsed.has(node.id)) {
      for (let i = matchingChildren.length - 1; i >= 0; i--) {
        const child = matchingChildren[i]!;
        stack.push({ node: child, depth: depth + 1, guides: depth ? [...guides, !last] : [], last: i === matchingChildren.length - 1, path: `${path} / ${child.title}` });
      }
    }
  }
  return { rows, meta };
}
