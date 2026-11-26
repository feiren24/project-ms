import { projectRoleLabels } from '../../../../shared/src/permissions';
export const roles = projectRoleLabels;
export const weekdays = [{ value: 1, label: '周一' }, { value: 2, label: '周二' }, { value: 3, label: '周三' }, { value: 4, label: '周四' }, { value: 5, label: '周五' }, { value: 6, label: '周六' }, { value: 0, label: '周日' }];
export const hoursLabel = (hours: number | null) => hours === null ? '未配置 · 容量未知' : hours === 0 ? '0 小时 · 无容量' : `${hours} 小时 / 工作日`;
export const dateTime = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
