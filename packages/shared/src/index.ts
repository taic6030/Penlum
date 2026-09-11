export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  JOBS: Queue<Job>;
  ADMIN_ASSETS: Fetcher;
  ENVIRONMENT: string;
  ADMIN_HOST: string;
  GSC_CLIENT_ID?: string;
  GSC_CLIENT_SECRET?: string;
  GSC_REFRESH_TOKEN?: string;
}
export interface Job {
  id: string;
  site_id?: string;
  type: 'audit' | 'export' | 'analytics' | 'purge';
  date?: string;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new AppError(status, code, message);
};
export const now = () => new Date().toISOString();
export const id = () => crypto.randomUUID();
export const escape = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export async function hash(value: string | ArrayBuffer) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
}
export function normalizeHost(host: string) {
  if (/[/\\@\s?#]/.test(host)) fail(400, 'invalid_host', 'Invalid hostname');
  try {
    return new URL(`https://${host}`).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return fail(400, 'invalid_host', 'Invalid hostname');
  }
}
export function safeURL(value: string, relative = true) {
  if (relative && value.startsWith('/') && !value.startsWith('//') && !/[\\\r\n]/.test(value))
    return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href;
  } catch {}
  return fail(422, 'invalid_url', 'Use an HTTPS URL or an absolute local path');
}
export const jsonScript = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
