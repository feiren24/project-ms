import { requestCanViewManagement } from '../auth/project-access.js';
import type Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { readActivities, readActivityItems } from './repository.js';
/** Existing business authorization checks membership for both endpoints, including viewers. */
export function registerActivityRoutes(app:FastifyInstance,db:Database.Database,clock:()=>Date) {
 const prefix='/api/v1/projects/:projectId/activities';
 app.get<{Params:{projectId:string};Querystring:Record<string,unknown>}>(prefix,(request,reply)=>{reply.header('Cache-Control','no-store');return {data:readActivities(db,request.params.projectId,request.query,clock(),requestCanViewManagement(request))};});
 app.get<{Params:{projectId:string;activityId:string};Querystring:Record<string,unknown>}>(`${prefix}/:activityId/items`,(request,reply)=>{reply.header('Cache-Control','no-store');return {data:readActivityItems(db,request.params.projectId,request.params.activityId,request.query,clock(),requestCanViewManagement(request))};});
}
