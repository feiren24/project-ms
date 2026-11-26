export interface SystemSettingsStatus {
  version: number;
  state: 'missing' | 'ready' | 'invalid';
  source: 'environment' | 'file' | 'none';
  canGenerate: boolean;
  canImport: boolean;
  hasCredentials: boolean;
  credentialCount: number;
  canBackup: boolean;
  canRotate: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
  message: string | null;
}
export interface SaveFeishuKeyInput { expectedVersion: number; mode: 'generate' | 'import' | 'rotate'; key?: string; confirmed?: boolean }
export interface SystemSettingsAudit {
  items: { id: string; at: string; actor: string; action: string; result: string }[];
  page: number;
  total: number;
}

export interface SystemKeyBackup { key: string; version: number; exportedAt: string }
