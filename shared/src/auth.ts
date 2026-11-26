import type { ProjectRole, ModuleCapabilities } from './permissions';
export interface AuthUser { id: string; username: string; name: string; systemRole: 'admin'|'user'; active: boolean; canCreateProjects: boolean; mustChangePassword: boolean; version: number }
export interface AuthProject { id: string; name: string; memberId: string; role: ProjectRole; capabilities?: ModuleCapabilities }
export interface AuthSession { user: AuthUser|null; csrfToken: string; projects: AuthProject[]; initialized: boolean; legacyDemo?: boolean }
export interface UserDirectory { users: AuthUser[] }
export interface UserCreate { username: string; name: string; systemRole: 'admin'|'user'; canCreateProjects: boolean }
export interface UserUpdate { expectedVersion: number; name: string; systemRole: 'admin'|'user'; active: boolean; canCreateProjects: boolean }
export interface IssuedCredential { user: AuthUser; initialPassword: string }
