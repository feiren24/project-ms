import { describe, expect, it } from 'vitest';
import { buildPlanTree } from '../../client/src/features/gantt/plan-tree';
import { hierarchyFixture, hierarchyNode } from '../helpers/plan-hierarchy-fixture';

describe('complete plan hierarchy', () => {
  const nodes = hierarchyFixture();
  const all = new Set(nodes.map(node => node.id));
  it('uses parent relationships rather than preserved WBS and distinguishes workstreams from summary tasks', () => {
    const tree = buildPlanTree(nodes, all, []);
    expect(tree.rows.map(node => node.id)).toEqual(['root', 'parent', 'nested', 'one', 'two', 'three', 'empty', 'standalone']);
    expect(tree.meta.get('one')).toMatchObject({ depth: 3, isParent: false, parentTitle: '公共组件' });
    expect(tree.meta.get('two')?.depth).toBe(3);
    expect(tree.meta.get('root')?.isParent).toBe(false);
    expect(tree.meta.get('parent')).toMatchObject({ isParent: true, childCount: 2 });
    expect(tree.meta.get('empty')).toMatchObject({ isParent: true, childCount: 0, startsChildren: false });
  });
  it('ends branches at the last sibling and separators at the end of each whole subtree', () => {
    const { meta } = buildPlanTree(nodes, all, []);
    expect(meta.get('one')).toMatchObject({ guides: [true, true], last: false, subtreeEnd: false });
    expect(meta.get('two')).toMatchObject({ guides: [true, true], last: true, subtreeEnd: true });
    expect(meta.get('three')).toMatchObject({ guides: [true], last: true, subtreeEnd: true });
    expect(meta.get('parent')?.subtreeEnd).toBe(false);
    expect(meta.get('standalone')?.last).toBe(true);
  });
  it('retains ancestors and full direct counts while filtering, even when a matching branch is collapsed', () => {
    const matches = new Set(['two']);
    const tree = buildPlanTree(nodes, matches, [], true);
    expect(tree.rows.map(n => n.id)).toEqual(['root', 'parent', 'nested', 'two']);
    expect(tree.meta.get('parent')).toMatchObject({ childCount: 2, matchingChildCount: 1, contextOnly: true });
    expect(tree.meta.get('nested')?.caption).toContain('1 / 共 2');
    expect(tree.meta.get('two')).toMatchObject({ guides: [false, false], last: true, contextOnly: false, subtreeEnd: true });
    const folded = buildPlanTree(nodes, matches, ['nested'], true);
    expect(folded.rows.map(n => n.id)).toEqual(['root', 'parent', 'nested']);
    expect(folded.meta.get('nested')).toMatchObject({ startsChildren: false, childCount: 2, matchingChildCount: 1, subtreeEnd: true });
    expect([...matches]).toEqual(['two']);
  });
  it('recomputes guides after sibling reordering without changing source records', () => {
    const before = JSON.stringify(nodes);
    const moved = [nodes[0]!, nodes[7]!, ...nodes.slice(1, 7)];
    const tree = buildPlanTree(moved, all, []);
    expect(tree.rows.map(n => n.id)).toEqual(['root', 'standalone', 'parent', 'nested', 'one', 'two', 'three', 'empty']);
    expect(tree.meta.get('standalone')?.last).toBe(false);
    expect(tree.meta.get('empty')?.last).toBe(true);
    expect(JSON.stringify(nodes)).toBe(before);
  });
  it('computes branches across a 5000-row window boundary before rendering or paging', () => {
    const large = [nodes[0]!, nodes[1]!, ...Array.from({ length: 5000 }, (_, i) => hierarchyNode(`item-${i}`, 'parent'))];
    const tree = buildPlanTree(large, new Set(large.map(n => n.id)), []);
    expect(tree.rows).toHaveLength(5002);
    expect(tree.meta.get('item-2500')).toMatchObject({ depth: 2, guides: [false], last: false, subtreeEnd: false, parentTitle: nodes[1]!.title });
    expect(tree.meta.get('item-4999')).toMatchObject({ last: true, subtreeEnd: true });
    expect(tree.meta.get('parent')?.childCount).toBe(5000);
  });
});
