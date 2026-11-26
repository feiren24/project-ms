import type { ProjectOverview } from '../../../shared/src/contracts';
import { milestoneStateLabels } from '../../../shared/src/milestones';
type Summary = Pick<ProjectOverview['milestones'][number], 'milestoneState'>;
/** Summary compatibility statuses do not prove that a submission exists. */
export function milestoneSummaryLabel(milestone: Summary): string {
 return milestone.milestoneState ? milestoneStateLabels[milestone.milestoneState] : '验收状态待核实';
}
export function milestoneAttention(milestone: Summary): {type:'review'|'milestone';label:string;subtitle:string}|null {
 switch (milestone.milestoneState) {
  case 'submitted': return {type:'review',label:'待验收',subtitle:'交付物已提交，等待验收确认'};
  case 'needs_review': return {type:'milestone',label:'需复核',subtitle:'必要成果已变化，需重新核对并提交'};
  case 'legacy_achieved': return {type:'milestone',label:'待补验收',subtitle:'历史记录缺少正式凭证，需补充成果并提交'};
  default: return null;
 }
}
