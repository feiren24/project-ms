import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useAuthStore } from '../../client/src/stores/auth';
import { useProjectsStore } from '../../client/src/stores/projects';
import { sessionFetch } from '../../client/src/api/session-transport';
import { clearProjectViews, setProjectScope, useProjectView } from '../../client/src/stores/project-scope';
import type { AuthSession } from '../../shared/src/auth';
const allowed = { analytics: true, risks: true, settings: true }, denied = { analytics: false, risks: false, settings: false };
const initial = (): AuthSession => ({ user: { id: 'same-user', username: 'same-user', name: '测试', systemRole: 'user', active: true, canCreateProjects: false, mustChangePassword: false, version: 1 }, initialized: true, csrfToken: '', projects: ['a','b'].map(id => ({ id, name: id, memberId: 'actor', role: 'manager', capabilities: { ...allowed } })) });
function bodyStream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const response = new Response(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }), { status: 200 });
  return { response, finish(value: unknown) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value))); controller.close(); } };
}
describe('permission response and project isolation', () => {
  beforeEach(() => { setActivePinia(createPinia()); clearProjectViews(); vi.stubGlobal('window', { location: { href: 'http://localhost/' } }); useAuthStore().session = initial(); });
  afterEach(() => vi.unstubAllGlobals());
  test('directory headers arriving before downgrade do not authorize its delayed body', async () => {
    const auth = useAuthStore(), stream = bodyStream();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response));
    const response = await sessionFetch('/api/v1/projects');
    const parsed = response.json();
    auth.updateCapabilities('a', denied);
    stream.finish({ data: { projects: initial().projects } });
    await expect(parsed).rejects.toMatchObject({ name: 'AbortError' });
  });
  test('directory store never reapplies old same-user roles after a body-stream downgrade', async () => {
    const auth = useAuthStore(), directory = useProjectsStore(), stream = bodyStream();
    const received = vi.fn().mockResolvedValue(stream.response); vi.stubGlobal('fetch', received);
    const loading = directory.load();
    await vi.waitFor(() => expect(stream.response.bodyUsed).toBe(true));
    auth.session!.projects[0].role = 'member'; auth.updateCapabilities('a', denied);
    stream.finish({ data: { projects: initial().projects, canCreate: false } });
    await loading;
    expect(auth.session!.projects[0].role).toBe('member'); expect(auth.capabilities('a')).toEqual(denied);
    expect(directory.projects).toEqual([]); expect(directory.loaded).toBe(false);
  });
  test('revoking A clears A views but retains B filter and pending B response', async () => {
    const auth = useAuthStore();
    setProjectScope('a'); const a = useProjectView('analytics', () => ({ secret: 'private' }));
    setProjectScope('b'); const b = useProjectView('tasks', () => ({ filter: 'mine', draft: 'unsaved B draft' }));
    const stream = bodyStream(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response));
    const response = await sessionFetch('/api/v1/projects/b/tasks'), parsed = response.json();
    auth.updateCapabilities('a', denied); stream.finish({ data: 'B result' });
    await expect(parsed).resolves.toEqual({ data: 'B result' });
    expect(useProjectView('tasks', () => ({ filter: '', draft: '' }))).toBe(b);
    expect(b).toEqual({ filter: 'mine', draft: 'unsaved B draft' });
    setProjectScope('a'); expect(useProjectView('analytics', () => ({ secret: '' }))).not.toBe(a);
  });
  test('identity loss clears all project caches and rejects unrelated pending responses', async () => {
    const auth = useAuthStore(); setProjectScope('b'); const b = useProjectView('tasks', () => ({ draft: 'old identity' }));
    const stream = bodyStream(); vi.stubGlobal('fetch', vi.fn().mockResolvedValue(stream.response));
    const response = await sessionFetch('/api/v1/projects/b/tasks'), parsed = response.json();
    auth.session = null; stream.finish({ data: 'old result' });
    await expect(parsed).rejects.toMatchObject({ name: 'AbortError' });
    auth.session = initial(); expect(useProjectView('tasks', () => ({ draft: '' }))).not.toBe(b);
  });
});
