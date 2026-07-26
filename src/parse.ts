/**
 * Coercion helpers for untrusted request bodies.
 *
 * These existed as four separate copies of `stringOrUndefined` (api.ts, public-api.ts,
 * admin-api.ts, geo.ts) plus two each of the others, none of them shared.
 *
 * Free of runtime imports so the regression runner can load modules that use it.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function numberOrDefault(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    return Number(value);
  }
  return fallback;
}

export function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    // The previous form compared the raw string, so `"TRUE "` and `"True"` silently fell
    // through to the default.
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
      return true;
    }
    if (normalized === 'false' || normalized === '0' || normalized === 'no') {
      return false;
    }
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  return fallback;
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; error: string };

export async function readJson<T>(request: Request): Promise<JsonResult<T>> {
  const contentType = request.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    return { ok: false, error: '仅支持 application/json' };
  }
  try {
    return { ok: true, value: (await request.json()) as T };
  } catch {
    return { ok: false, error: 'JSON 格式无效' };
  }
}
