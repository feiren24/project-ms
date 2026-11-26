import { readTaskPage, readTaskEditor } from './query.js';
import { requestCanViewManagement } from '../auth/project-access.js';
import { readSession } from '../auth/store.js';
import { previewWorkstreamChange } from './workstream-change.js';
import { previewRecycle, readRecyclePage, readRecycledTask, taskCapabilities, writeRecycle } from './recycle.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { initializeTasks, previewParent, readTasks, writeTask } from './repository.js';

export function registerTaskRoutes(app: FastifyInstance, db: Database.Database, clock: () => Date, protection: { token: string; protectWrite: (request: FastifyRequest) => Promise<void> }, authenticatedActorName?: (request: FastifyRequest) => string) {
  initializeTasks(db);
  const accountId = (request: FastifyRequest) => authenticatedActorName ? readSession(db, request, clock())?.user.id ?? null : undefined;
  const prefix = '/api/v1/projects/:projectId/tasks';
  app.get<{ Params: { projectId: string } }>(prefix, (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { data: taskCapabilities(db, readTasks(db, request.params.projectId, protection.token, clock()), request.headers['x-demo-actor'],accountId(request)) };
  });
  app.get<{ Params: { projectId: string }; Querystring: Record<string,unknown> }>(`${prefix}/query`, (request,reply) => {
    reply.header('Cache-Control','no-store'); const page = readTaskPage(db,request.params.projectId,request.query,request.headers['x-demo-actor'],protection.token,clock()); return { data: {...page,...taskCapabilities(db,page,request.headers['x-demo-actor'] ?? request.query.actorId,accountId(request))} };
  });
  app.get<{ Params: { projectId: string }; Querystring: {workstreamId?:string} }>(`${prefix}/options`, (request,reply) => {
    reply.header('Cache-Control','no-store'); return { data: taskCapabilities(db,readTaskEditor(db,request.params.projectId,protection.token,clock(),undefined,request.query.workstreamId),request.headers['x-demo-actor'],accountId(request)) };
  });
  app.get<{ Params: { projectId: string; taskId: string } }>(`${prefix}/:taskId`, (request,reply) => {
    reply.header('Cache-Control','no-store'); return { data: taskCapabilities(db,readTaskEditor(db,request.params.projectId,protection.token,clock(),request.params.taskId),request.headers['x-demo-actor'],accountId(request)) };
  });
  app.post<{ Params: { projectId: string }; Body: unknown }>(`${prefix}/parent-preview`, { preHandler: protection.protectWrite }, request => ({ data: previewParent(db, request.params.projectId, request.body, request.headers['x-demo-actor']) }));
  app.post<{ Params: { projectId: string; taskId: string }; Body: unknown }>(`${prefix}/:taskId/workstream-preview`, { preHandler: protection.protectWrite }, request => ({ data: previewWorkstreamChange(db, request.params.projectId, request.params.taskId, request.body, request.headers['x-demo-actor'], clock(), accountId(request)) }));
  app.get<{Params:{projectId:string};Querystring:Record<string,unknown>}>(`${prefix}/deleted`, (request,reply)=>{reply.header('Cache-Control','no-store');return {data:readRecyclePage(db,request.params.projectId,request.headers['x-demo-actor'],request.query)};});
  app.get<{Params:{projectId:string;taskId:string}}>(`${prefix}/deleted/:taskId`, (request,reply)=>{reply.header('Cache-Control','no-store');return {data:readRecycledTask(db,request.params.projectId,request.params.taskId,request.headers['x-demo-actor'])};});
  for(const operation of ['delete','restore'] as const) {
    const path=operation==='delete'?`${prefix}/:taskId/delete`:`${prefix}/deleted/:taskId/restore`;
    app.post<{Params:{projectId:string;taskId:string}}>(`${path}-preview`,{preHandler:protection.protectWrite},request=>{
      const preview = previewRecycle(db,request.params.projectId,request.params.taskId,operation,request.headers['x-demo-actor'],clock());
      if (requestCanViewManagement(request)) return { data: preview };
      const blockers = preview.blockers.filter(blocker => blocker.kind !== 'risk');
      if (blockers.length !== preview.blockers.length) blockers.push({kind:'risk',id:'restricted',title:'存在需管理人员处理的关联',message:'请联系项目负责人或项目管理员处理关联后再重试。'});
      return { data: { ...preview, blockers } };
    });
    app.post<{Params:{projectId:string;taskId:string};Body:unknown}>(path,{preHandler:protection.protectWrite},request=>({data:writeRecycle(db,request.params.projectId,request.params.taskId,operation,request.headers['x-demo-actor'],request.body,request.headers['idempotency-key'],clock(),authenticatedActorName?.(request))}));
  }
  for (const route of [
    { method: 'POST', path: '', operation: 'create' }, { method: 'PATCH', path: '/:taskId', operation: 'update' },
    { method: 'POST', path: '/:taskId/transition', operation: 'transition' }, { method: 'POST', path: '/:taskId/comments', operation: 'comment' },
    { method: 'POST', path: '/batch', operation: 'batch' },
  ] as const) {
    app.route<{ Params: { projectId: string; taskId?: string }; Body: unknown }>({ method: route.method, url: `${prefix}${route.path}`, preHandler: protection.protectWrite, bodyLimit: 128 * 1024,
      handler: request => ({ data: writeTask(db, request.params.projectId, route.operation, request.params.taskId, request.body, request.headers['x-demo-actor'], request.headers['idempotency-key'], clock(), authenticatedActorName?.(request), accountId(request)) }) });
  }
}
