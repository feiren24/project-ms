import { collaborationPlanActions, publicPlanHistory } from '../auth/project-access.js';
export { collaborationPlanActions } from '../auth/project-access.js';

const privateDomains = ['risk', 'alert', 'settings', 'member', 'members', 'capacity', 'calendar'];

export function managementEvent(kind: string, targetKind?: string): boolean {
  if (privateDomains.includes(targetKind ?? '') || kind.split(/[._]/).some(part => privateDomains.includes(part))) return true;
  // Unknown plan history actions are not automatically safe collaboration events.
  return (targetKind === 'plan' || kind.startsWith('plan.')) && !(kind.startsWith('plan.') && publicPlanHistory({ action: kind.slice(5) }));
}

/** Internal SQL only: keep this predicate before LIMIT and use it for direct detail too.
 * Hide an entire mixed group, since its summary/preview can describe private children.
 */
export function publicActivitySql(alias = 'g'): string {
  const publicPlanTypes = collaborationPlanActions.map(action => `'plan.${action}'`).join(',');
  const domains = privateDomains.map(domain => `'${domain}'`).join(',');
  return `${alias}.category IN ('task','plan','project','workgroup')
    AND (${alias}.type LIKE 'task.%' OR ${alias}.type LIKE 'milestone.%' OR ${alias}.type LIKE 'workgroup.%' OR ${alias}.type LIKE 'plan.里程碑：%' OR ${alias}.type IN ('project.create','project.update',${publicPlanTypes}))
    AND ${privateDomains.map(domain => `('.' || replace(${alias}.type,'_','.') || '.') NOT LIKE '%.${domain}.%'`).join(' AND ')}
    AND COALESCE(json_extract(${alias}.target_json,'$.kind'),'') NOT IN (${domains})
    AND NOT EXISTS (SELECT 1 FROM activity_items private_item WHERE private_item.group_id=${alias}.id AND json_extract(private_item.target_json,'$.kind') IN (${domains}))`;
}
