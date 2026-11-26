import type { AuthSession, AuthUser, IssuedCredential, UserCreate, UserDirectory, UserUpdate } from '../../../shared/src/auth';

export class AuthError extends Error {
  constructor(message: string, public status = 0, public code = '') { super(message); this.name = 'AuthError'; }
}
async function request<T>(path: string, method = 'GET', body?: unknown, csrfToken?: string, key?: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(csrfToken ? { 'X-CSRF-Token': csrfToken } : {}), ...(key ? { 'Idempotency-Key': key } : {}),
    }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new AuthError('网络连接中断，请检查连接后重试。'); }
  const result = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && path.startsWith('/admin/')) window.dispatchEvent(new CustomEvent('gw-session-expired'));
    throw new AuthError(result?.error?.message || '操作未完成，请重试。', response.status, result?.error?.code);
  }
  if (!result || !('data' in result)) throw new AuthError('未收到完整结果，请重新读取后确认。');
  return result.data as T;
}
export const fetchSession = () => request<AuthSession>('/auth/session');
export const login = (username: string, password: string) => request<AuthSession>('/auth/login', 'POST', { username, password });
export const logout = (csrf: string) => request<AuthSession>('/auth/logout', 'POST', {}, csrf);
export const changePassword = (csrf: string, currentPassword: string, newPassword: string, key: string) => request<AuthSession>('/auth/password', 'POST', { currentPassword, newPassword }, csrf, key);
export const fetchUsers = () => request<UserDirectory>('/admin/users');
export const createUser = (csrf: string, body: UserCreate, key: string) => request<IssuedCredential>('/admin/users', 'POST', body, csrf, key);
export const updateUser = (csrf: string, id: string, body: UserUpdate, key: string) => request<AuthUser>(`/admin/users/${encodeURIComponent(id)}`, 'PATCH', body, csrf, key);
export const resetPassword = (csrf: string, id: string, expectedVersion: number, key: string) => request<IssuedCredential>(`/admin/users/${encodeURIComponent(id)}/password-reset`, 'POST', { expectedVersion }, csrf, key);
