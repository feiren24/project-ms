import type { RiskLevel, RiskState, RiskAction, ManagedRisk } from '../../../../shared/src/risks';
export const levels: Record<RiskLevel, string> = { low: '低', medium: '中', high: '高', critical: '严重' };
export const states: Record<RiskState, string> = { identified: '已识别', assessed: '已评估', mitigating: '应对中', monitoring: '监控中', pending_close: '待关闭复核', closed: '已关闭' };
export const actions: Record<RiskAction, string> = { assess: '完成评估', mitigate: '开始应对', monitor: '转入监控', accept: '接受风险', occur: '标记已发生', submit_close: '提交关闭复核', approve_close: '通过关闭', reject_close: '退回修改', reopen: '重新打开' };
export const levelFor = (score: number): RiskLevel => score < 5 ? 'low' : score < 10 ? 'medium' : score < 17 ? 'high' : 'critical';
export const riskLevel = (risk: ManagedRisk) => risk.score === null && risk.legacyLevel ? `${levels[risk.legacyLevel]} · 历史示例等级` : risk.level ? levels[risk.level] : '待评估';
export const dateTime = (date: string) => new Date(date).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
