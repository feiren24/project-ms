import { operationReasonPolicy, type ReasonContext } from '../../shared/src/operation-reasons.js';
import { requireValue } from './modules/planning/errors.js';
/** Returns only a human-supplied note. Callers generate audit summaries separately. */
export function readOperationReason(value: unknown, context: ReasonContext, max: number): string {
  requireValue(value === undefined || (typeof value === 'string' && value.length <= max), 'INVALID_REASON', `说明须为文字，最多 ${max} 字。`);
  const reason = typeof value === 'string' ? value.trim() : '';
  requireValue(operationReasonPolicy(context) !== 'required' || reason.length > 0, 'REASON_REQUIRED', '此高危操作须填写原因或依据。');
  return reason;
}
