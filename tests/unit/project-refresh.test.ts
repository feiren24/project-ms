import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ProjectRevision } from '../../shared/src/notifications';
import type { useProjectRefresh } from '../../client/src/stores/useProjectRefresh';
const mocks = vi.hoisted(() => ({ revision: vi.fn(), settings: vi.fn(), session: vi.fn() }));
vi.mock('../../client/src/api/auth', () => ({ fetchSession: mocks.session }));
vi.mock('../../client/src/api/notifications', () => ({ fetchProjectRevision: mocks.revision }));
vi.mock('../../client/src/api/settings', () => ({ fetchSettings: mocks.settings }));
const actors = [{ id: 'zhou', name: '周亦安', role: 'manager' as const }, { id: 'chen', name: '陈知远', role: 'member' as const }];
const result = (revision: string, unread = 0, actorId = 'zhou'): ProjectRevision => ({ revision, unread, actorId, actors, capabilities: { analytics: true, risks: true, settings: true } });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
describe('foreground project revision checking', () => {
  let store: ReturnType<typeof useProjectRefresh>;
  let page: EventTarget & { visibilityState: string }, browser: EventTarget;
  beforeEach(async () => {
    vi.resetModules(); vi.useFakeTimers(); mocks.revision.mockReset(); mocks.settings.mockReset(); mocks.session.mockReset();
    const { createPinia, setActivePinia } = await import('pinia');
    setActivePinia(createPinia());
    store = (await import('../../client/src/stores/useProjectRefresh')).useProjectRefresh();
    browser = new EventTarget(); page = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    vi.stubGlobal('window', browser); vi.stubGlobal('document', page);
    mocks.revision.mockImplementation(async (actorId: string) => result('v1', 0, actorId));
  });
  afterEach(() => { store?.stop(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  test('first read establishes baseline, read counts alone do not mark business data stale', async () => {
    mocks.revision.mockResolvedValueOnce(result('v1', 3)); await store.check();
    expect(store.pending.value).toBe(false); expect(store.unread.value).toBe(3);
    mocks.revision.mockResolvedValueOnce(result('v1', 0)); await store.check();
    expect(store.pending.value).toBe(false); expect(store.unread.value).toBe(0);
    mocks.revision.mockResolvedValueOnce(result('v2')); await store.check();
    expect(store.pending.value).toBe(true);
    store.acknowledge('v1'); expect(store.pending.value).toBe(true);
    store.acknowledge('v2'); expect(store.pending.value).toBe(false);
    mocks.revision.mockResolvedValueOnce(result('v3')); await store.check();
    store.acknowledge(); expect(store.pending.value).toBe(false);
  });

  test('a late response for the prior actor cannot overwrite selected identity or unread count', async () => {
    const slow = deferred<ProjectRevision>(); mocks.revision.mockReturnValueOnce(slow.promise);
    const oldCheck = store.check(); store.actorId.value = 'chen';
    mocks.revision.mockResolvedValueOnce(result('v2', 2, 'chen')); await store.check();
    slow.resolve(result('v1', 99)); await oldCheck;
    expect(store.actorId.value).toBe('chen'); expect(store.unread.value).toBe(2);
    expect(store.revision.value).toBe('v2'); expect(store.pending.value).toBe(false);
  });

  test('a trusted revision refreshes the current project role without changing other memberships', async () => {
    const { useAuthStore } = await import('../../client/src/stores/auth');
    const auth = useAuthStore();
    auth.session = { projects: [
      { id: 'current', memberId: 'zhou', role: 'manager' },
      { id: 'other', memberId: 'zhou', role: 'manager' },
    ] } as NonNullable<typeof auth.session>;
    store.setScope('current');
    const { useProjectView, setProjectScope } = await import('../../client/src/stores/project-scope');
    setProjectScope('current');
    const cached = useProjectView('analytics', () => ({ selection: 'sensitive-person' }));
    const epoch = auth.directoryRevision, unrelatedKey = auth.projectPrivacyKey('other');
    mocks.revision.mockResolvedValueOnce({ ...result('v2'), capabilities: { analytics: false, risks: false, settings: false }, actors: [{ ...actors[0], role: 'viewer' }] });
    await store.check();
    expect(auth.session.projects.map(project => project.role)).toEqual(['viewer', 'manager']);
    expect(auth.capabilities('current')).toEqual({ analytics: false, risks: false, settings: false });
    expect(auth.capabilities('other')).toEqual({ analytics: true, risks: true, settings: true });
    expect(auth.directoryRevision).toBe(epoch + 1);
    expect(auth.projectPrivacyKey('other')).toBe(unrelatedKey);
    expect(useProjectView('analytics', () => ({ selection: null }))).not.toBe(cached);
    expect(mocks.session).not.toHaveBeenCalled();
    expect(store.error.value).toBe('');
  });

  test('a poll started before marking notifications read cannot restore the previous unread count', async () => {
    await store.check(); const slow = deferred<ProjectRevision>(); mocks.revision.mockReturnValueOnce(slow.promise);
    const checking = store.check();
    store.updateUnread({ actorId: 'zhou', unread: 0, actors });
    slow.resolve(result('v1', 6)); await checking;
    expect(store.unread.value).toBe(0); expect(store.pending.value).toBe(false);
    store.updateUnread({ actorId: 'chen', unread: 20, actors }); expect(store.unread.value).toBe(0);
  });

  test('polls only while visible, checks immediately on foreground/focus, and stops all listeners', async () => {
    store.start(); store.start(); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.revision).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000); expect(mocks.revision).toHaveBeenCalledTimes(2);
    page.visibilityState = 'hidden'; page.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(90_000); browser.dispatchEvent(new Event('focus'));
    expect(mocks.revision).toHaveBeenCalledTimes(2);
    page.visibilityState = 'visible'; page.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0);
    expect(mocks.revision).toHaveBeenCalledTimes(3);
    browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(0); expect(mocks.revision).toHaveBeenCalledTimes(4);
    store.stop(); browser.dispatchEvent(new Event('focus')); await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.revision).toHaveBeenCalledTimes(4);
  });

  test('legacy 403 keeps the disabled actor explicit, exposes recovery metadata, and never chooses a manager', async () => {
    const { useAuthStore } = await import('../../client/src/stores/auth');
    useAuthStore().session = { user: null, projects: [], csrfToken: '', initialized: true, legacyDemo: true };
    const { PlanningError } = await import('../../client/src/api/planning');
    store.actorId.value = 'chen'; mocks.revision.mockRejectedValueOnce(new PlanningError('disabled', 403));
    mocks.settings.mockResolvedValueOnce({ actors: [actors[0]] }); await store.check();
    expect(store.actorId.value).toBe('chen'); expect(store.unread.value).toBe(0);
    expect(store.error.value).toContain('已停用'); expect(store.actors.value).toEqual([actors[0]]);
    mocks.revision.mockResolvedValueOnce(result('v1', 1, 'chen')); await store.check();
    expect(store.error.value).toBe(''); expect(store.unread.value).toBe(1);
  });

  test('failed reads remain retryable and stopping invalidates even a response ignoring AbortSignal', async () => {
    mocks.revision.mockRejectedValueOnce(new Error('网络暂不可用')); await store.check();
    expect(store.error.value).toBe('网络暂不可用'); expect(store.checking.value).toBe(false);
    await store.check(); expect(store.error.value).toBe('');
    const slow = deferred<ProjectRevision>(); mocks.revision.mockReturnValueOnce(slow.promise);
    const checking = store.check(); store.stop(); slow.resolve(result('v9', 9)); await checking;
    expect(store.revision.value).toBe('v1'); expect(store.unread.value).toBe(0); expect(store.checking.value).toBe(false);
  });
  test('authenticated 403 never fetches private settings for recovery', async () => {
    const { PlanningError } = await import('../../client/src/api/planning');
    store.actorId.value = 'chen';
    mocks.revision.mockRejectedValueOnce(new PlanningError('disabled', 403));
    await store.check();
    expect(store.actorId.value).toBe('chen');
    expect(store.unread.value).toBe(0);
    expect(store.error.value).toContain('已停用');
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  test('missing revision capabilities refreshes session and adopts its latest permissions', async () => {
    const { useAuthStore } = await import('../../client/src/stores/auth');
    const auth = useAuthStore();
    auth.session = { user: null, projects: [{ id: 'current', name: '当前项目', memberId: 'zhou', role: 'manager' }], csrfToken: '', initialized: true };
    store.setScope('current');
    const wire = { ...result('v2') }; Reflect.deleteProperty(wire, 'capabilities');
    mocks.revision.mockResolvedValueOnce(wire);
    mocks.session.mockResolvedValueOnce({ ...auth.session, projects: [{ id: 'current', name: '当前项目', memberId: 'zhou', role: 'viewer', capabilities: { analytics: false, risks: false, settings: false } }] });
    await store.check();
    expect(mocks.session).toHaveBeenCalledTimes(1);
    expect(auth.capabilities('current').analytics).toBe(false);
    expect(auth.session.projects[0].role).toBe('viewer');
    expect(store.error.value).toBe('');
    expect(mocks.settings).not.toHaveBeenCalled();
  });

  test('session response started before revision downgrade cannot restore old management access', async () => {
    const { useAuthStore } = await import('../../client/src/stores/auth');
    const auth = useAuthStore();
    auth.session = { user: null, projects: [{ id: 'current', name: '当前项目', memberId: 'zhou', role: 'manager' }], csrfToken: '', initialized: true };
    store.setScope('current');
    const original = JSON.parse(JSON.stringify(auth.session));
    const slow = deferred<typeof original>(); mocks.session.mockReturnValueOnce(slow.promise);
    const pending = auth.refreshForRecovery();
    mocks.revision.mockResolvedValueOnce({ ...result('v2'), capabilities: { analytics: false, risks: false, settings: false }, actors: [{ ...actors[0], role: 'viewer' }] });
    await store.check(); slow.resolve(original); await pending;
    expect(auth.capabilities('current')).toEqual({ analytics: false, risks: false, settings: false });
    expect(auth.session.projects[0].role).toBe('viewer');
  });

});
