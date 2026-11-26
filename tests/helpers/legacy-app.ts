import { buildApp } from '../../server/src/app.js';

/**
 * Explicit compatibility fixture for the pre-authentication business regressions.
 * This runs inside test workers only; the separately running preview server keeps
 * its normal authenticated configuration. Authentication tests use buildApp directly.
 */
export function buildLegacyApp(options: Parameters<typeof buildApp>[0] = {}) {
  process.env.NODE_ENV = 'test';
  return buildApp({ ...options, testOnlyLegacyAuth: true });
}
