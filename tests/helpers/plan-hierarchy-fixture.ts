import type { PlanNode } from '../../shared/src/planning';

export function hierarchyNode(id: string, parentId: string | null, kind: PlanNode['kind'] = 'task', extra: Partial<PlanNode> = {}): PlanNode {
  return { id, parentId, kind, workstreamId: 'system-bottom', wbs: `old.${id}`, title: id,
    description: '隔离层级测试示例', owner: '测试成员', color: 'blue', status: 'todo',
    start: '2026-09-14', end: '2026-09-18', durationDays: 5, effortHours: 8, progress: 0, blocked: false, ...extra };
}

export function hierarchyFixture(): PlanNode[] {
  return [
    hierarchyNode('root', null, 'group', { title: '系统底座', wbs: '1' }),
    hierarchyNode('parent', 'root', 'group', { title: 'UI 与应用架构及公共组件设计', wbs: '1.S1af0141c', taskKind: 'summary' }),
    hierarchyNode('nested', 'parent', 'group', { title: '公共组件', taskKind: 'summary' }),
    hierarchyNode('one', 'nested', 'task', { title: '组件设计', wbs: '9.T01' }),
    hierarchyNode('two', 'nested', 'task', { title: '组件联调', wbs: '2' }),
    hierarchyNode('three', 'parent', 'task', { title: '页面架构设计' }),
    hierarchyNode('empty', 'root', 'group', { title: '权限体系', taskKind: 'summary' }),
    hierarchyNode('standalone', 'root', 'task', { title: '上线检查' }),
  ];
}
