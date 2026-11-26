import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { PlanError } from '../planning/errors.js';

// Bound expensive work, including unknown-account verification, without an unbounded queue.
let pendingHashes = 0;
const parameters = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
async function derive(password: string, salt: string): Promise<Buffer> {
  if (pendingHashes >= 4) throw new PlanError(503, 'AUTH_BUSY', '登录服务暂时忙碌，请稍后重试。');
  pendingHashes++;
  try { return await new Promise<Buffer>((resolve, reject) => scrypt(password, salt, 64, parameters, (error, key) => error ? reject(error) : resolve(key))); }
  finally { pendingHashes--; }
}
export function validatePassword(value: unknown): asserts value is string {
  if (typeof value !== 'string' || [...value].length < 12 || [...value].length > 128) throw new PlanError(422, 'INVALID_PASSWORD', '密码须为 12–128 个字符，空格也计入密码。');
}
export async function hashPassword(password: string): Promise<string> {
  validatePassword(password);
  const salt = randomBytes(24).toString('hex');
  return `scrypt$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const [, salt, expected] = encoded?.split('$') ?? [];
  const actual = await derive(password, salt ?? 'goodwork-unknown-account-timing-salt');
  if (!expected || !/^[a-f0-9]{128}$/.test(expected)) return false;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
export function initialPassword(): string { return `GW-${randomBytes(18).toString('base64url')}`; }
