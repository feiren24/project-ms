import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';

/** Only the compiled public directory is exposed; private paths never get an SPA fallback. */
export function registerWeb(app: FastifyInstance, root: string) {
  if (!existsSync(join(root, 'index.html'))) throw new Error('缺少前端构建文件，请先运行安装/构建命令。');
  app.register(fastifyStatic, { root, dotfiles:'deny', index:false, redirect:false, setHeaders(response, path) {
    response.header('Cache-Control', path.endsWith('.html') ? 'no-store' : 'public, max-age=3600');
    response.header('X-Content-Type-Options', 'nosniff');
  } });
  for (const path of ['/', '/login', '/workspace', '/account/password', '/account/logout', '/admin/settings', '/admin/users',
    ...['overview','plan','workstreams','tasks','risks','analytics','settings','tasks/:taskId','risks/:riskId'].map(page => `/projects/:projectId/${page}`)]) {
    app.get(path, (_request, reply) => reply.header('Cache-Control','no-store').sendFile('index.html'));
  }
  app.setNotFoundHandler((request, reply) => reply.code(404).send({error:{code:'NOT_FOUND',message:'资源不存在。'},requestId:request.id}));
}
