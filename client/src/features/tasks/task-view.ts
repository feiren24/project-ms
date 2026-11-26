import type { TaskDateMode } from '../../../../shared/src/task-dates';
/** Tasks and recycle bin share the same complete per-project browsing context. */
export const defaultTaskView = () => ({query:'',stream:'',owner:'',state:'active',priority:'',due:'',dateMode:'overlap' as TaskDateMode,dateFrom:'',dateTo:'',scope:'all',display:'list',actor:'zhou',sort:'due',boardColumn:'todo',page:1,pageSize:50});
