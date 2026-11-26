export class PlanError extends Error {
  constructor(public statusCode: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export function requireValue(condition: unknown, code: string, message: string, details?: unknown): asserts condition {
  if (!condition) throw new PlanError(422, code, message, details);
}
