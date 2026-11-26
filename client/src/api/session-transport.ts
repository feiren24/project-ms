import { watch } from 'vue';
import { privateModule } from '../utils/module-privacy';
import { useAuthStore } from '../stores/auth';
/** Business requests always use the current session; no client-selected actor in authenticated mode. */
export async function sessionFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const auth = useAuthStore();
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  const match = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)(?:\/([^/]+))?/);
  const projectId = match ? decodeURIComponent(match[1]) : '';
  const directory = /^\/api\/v1\/projects\/?$/.test(url.pathname);
  const revisionForRequest = () => projectId ? auth.projectPrivacyKey(projectId) : directory ? auth.directoryRevision : auth.privacyRevision;
  const revision = revisionForRequest();
  const module = privateModule(match?.[2]);
  if (module && !auth.capabilities(projectId)[module]) throw new Error('当前角色无权访问此模块。');
  const stale = () => { if (revision !== revisionForRequest()) throw new DOMException('项目权限已变化，请重新读取。', 'AbortError'); };
  const controller = new AbortController();
  const abort = () => controller.abort();
  init?.signal?.addEventListener('abort', abort, { once: true });
  const stop = watch(revisionForRequest, abort, { flush: 'sync' });
  if (init?.signal?.aborted) controller.abort();
  const headers = new Headers(init?.headers);
  if (!auth.session?.legacyDemo) {
    headers.delete('x-demo-actor');
    if (init?.method && !['GET','HEAD'].includes(init.method.toUpperCase())) headers.set('x-csrf-token', auth.session?.csrfToken ?? '');
  }
  let response: Response;
  try { response = await fetch(input, { ...init, signal: controller.signal, headers, credentials: 'same-origin' }); }
  finally { stop(); init?.signal?.removeEventListener('abort', abort); }
  stale();
  const json = response.json.bind(response);
  response.json = async () => { stale(); const body = await json(); stale(); return body; };
  if (auth.user && !auth.session?.legacyDemo) {
    if (response.status === 401) auth.markExpired();
    if (response.status === 404) {
      const body = await response.clone().json().catch(() => null);
      if (body?.error?.code === 'PROJECT_NOT_FOUND') {
        // A removed membership must leave the project even in an existing session.
        try {
          await auth.refreshForRecovery();
          const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
          const projectId = url.pathname.match(/^\/api\/v1\/projects\/([^/]+)/)?.[1];
          if (projectId && !auth.session?.projects.some(p => p.id === decodeURIComponent(projectId))) window.dispatchEvent(new CustomEvent('gw-project-access-revoked', { detail: decodeURIComponent(projectId) }));
        } catch { /* Login recovery owns expired sessions. */ }
      }
    }
    if (response.status === 403) {
      const body = await response.clone().json().catch(() => null);
      if (['CSRF_REQUIRED', 'PASSWORD_CHANGE_REQUIRED'].includes(body?.error?.code)) auth.markExpired();
      else if (module) {
        try { await auth.refreshForRecovery(); } catch { /* Explicit login recovery handles an expired session. */ }
      }
    }
  }
  return response;
}
