import { projectApi } from '../stores/project-scope';
import type {RecyclePage,RecycledTask,RecyclePreview} from '../../../shared/src/task-recycle';
import { sessionFetch } from './session-transport';
import type { TaskPage, TaskDraft, TaskWorkspace, TaskMutation, TaskWriteResult, ParentPreview, ParentConfirmation, WorkstreamChangePreview } from '../../../shared/src/tasks';
import { PlanningError } from './planning';
async function request<T>(path: string, method = 'GET', workspace?: TaskWorkspace, actorId?: string, body?: unknown, key?: string, projectId?: string): Promise<T> {
  const response = await sessionFetch(projectApi(workspace?.project.id || projectId) + '/tasks' + path, { method, headers: body === undefined ? (actorId ? {'X-Demo-Actor':actorId} : {}) : { 'Content-Type': 'application/json', 'X-Preview-Token': workspace!.writeToken, 'X-Demo-Actor': actorId!, 'Idempotency-Key': key || crypto.randomUUID() }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new PlanningError(result.error?.message || '任务暂时无法读取或保存，请重试。', response.status, result.error?.code);
  return result.data;
}
export const fetchTasks = (projectId?: string) => request<TaskWorkspace>('', 'GET', undefined, undefined, undefined, undefined, projectId);
export const createTask = (workspace: TaskWorkspace, actor: string, draft: TaskDraft, key: string, confirmation?: ParentConfirmation) => request<TaskWriteResult>('', 'POST', workspace, actor, { ...draft, ...confirmation, expectedPlanVersion: workspace.planVersion }, key);
export const previewParent = (workspace: TaskWorkspace, actor: string, payload: { parentId: string; workstreamId: string; expectedPlanVersion: number }) => request<ParentPreview>('/parent-preview', 'POST', workspace, actor, payload);
export const updateTask = (workspace: TaskWorkspace, actor: string, id: string, draft: TaskDraft, expectedVersion: number, key: string, workstreamPreviewToken?: string) => request<TaskWriteResult>(`/${encodeURIComponent(id)}`, 'PATCH', workspace, actor, { ...draft, ...(workstreamPreviewToken ? {workstreamPreviewToken} : {}), expectedVersion, expectedPlanVersion: workspace.planVersion, expectedStructureVersion: workspace.structureVersion }, key);
export const previewWorkstreamChange = (workspace: TaskWorkspace, actor: string, id: string, workstreamId: string) => request<WorkstreamChangePreview>(`/${encodeURIComponent(id)}/workstream-preview`, 'POST', workspace, actor, {workstreamId});
export const mutateTask = (workspace: TaskWorkspace, actor: string, id: string, mutation: TaskMutation, key: string) => request<TaskWriteResult>(`/${encodeURIComponent(id)}/transition`, 'POST', workspace, actor, mutation, key);
export const commentTask = (workspace: TaskWorkspace, actor: string, id: string, text: string, expectedVersion: number, key: string) => request<TaskWriteResult>(`/${encodeURIComponent(id)}/comments`, 'POST', workspace, actor, { text, expectedVersion, expectedPlanVersion: workspace.planVersion, expectedStructureVersion: workspace.structureVersion }, key);
export const batchTasks = (workspace: TaskWorkspace, actor: string, items: Array<{ id: string; expectedVersion: number }>, patch: { ownerId?: string; priority?: 'P0'|'P1'|'P2' }, reason: string, key: string) => request<{ affectedCount: number; planVersion: number }>('/batch', 'POST', workspace, actor, { expectedPlanVersion: workspace.planVersion, items, patch, reason }, key);

export const fetchTaskPage = (projectId: string, query: Record<string,string>) => request<TaskPage>(`/query?${new URLSearchParams(query)}`, 'GET', undefined, undefined, undefined, undefined, projectId);
export const fetchTaskDetail = (projectId: string, id: string, actorId?:string) => request<TaskWorkspace>(`/${encodeURIComponent(id)}`, 'GET', undefined, actorId, undefined, undefined, projectId);
export const fetchTaskOptions = (projectId: string, workstreamId = '') => request<TaskWorkspace>(`/options?${new URLSearchParams({workstreamId})}`, 'GET', undefined, undefined, undefined, undefined, projectId);
export const fetchRecyclePage=(projectId:string,actorId:string,query:Record<string,string>)=>request<RecyclePage>(`/deleted?${new URLSearchParams(query)}`,'GET',undefined,actorId,undefined,undefined,projectId);
export const fetchRecycledTask=(projectId:string,actorId:string,id:string)=>request<RecycledTask>(`/deleted/${encodeURIComponent(id)}`,'GET',undefined,actorId,undefined,undefined,projectId);
export const previewTaskRecycle=(workspace:TaskWorkspace,actorId:string,id:string,operation:'delete'|'restore')=>request<RecyclePreview>(operation==='delete'?`/${encodeURIComponent(id)}/delete-preview`:`/deleted/${encodeURIComponent(id)}/restore-preview`,'POST',workspace,actorId,{});
export const writeTaskRecycle=(workspace:TaskWorkspace,actorId:string,id:string,operation:'delete'|'restore',body:{previewToken:string;reason:string},key:string)=>request<{taskId:string;operation:string}>(operation==='delete'?`/${encodeURIComponent(id)}/delete`:`/deleted/${encodeURIComponent(id)}/restore`,'POST',workspace,actorId,body,key);
