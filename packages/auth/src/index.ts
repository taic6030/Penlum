import { Database, type Actor } from '../../db/src/index';
import { fail, hash, now, type Env } from '../../shared/src/index';
export const roleScopes: Record<string, string[]> = {
  site_admin: [
    'sites:read',
    'sites:write',
    'content:read',
    'content:write',
    'content:publish',
    'media:write',
    'seo:read',
    'seo:write',
    'analytics:read',
    'users:read',
    'users:write',
    'code:write',
  ],
  editor: [
    'sites:read',
    'content:read',
    'content:write',
    'content:publish',
    'media:write',
    'seo:read',
    'seo:write',
  ],
  author: ['sites:read', 'content:read', 'content:write', 'media:write'],
  analyst: ['sites:read', 'content:read', 'seo:read', 'analytics:read'],
  viewer: ['sites:read', 'content:read', 'seo:read'],
};
export const allScopes = [
  'sites:read',
  'sites:write',
  'content:read',
  'content:write',
  'content:publish',
  'media:write',
  'seo:read',
  'seo:write',
  'analytics:read',
  'users:read',
  'users:write',
  'code:write',
  'system:admin',
];
export async function passwordHash(password: string, salt: string = crypto.randomUUID()) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const result = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: new TextEncoder().encode(salt), iterations: 100000, hash: 'SHA-256' },
    key,
    256,
  );
  return `pbkdf2:100000:${salt}:${Array.from(new Uint8Array(result))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}
function equal(a: string, b: string) {
  let out = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    out |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return out === 0;
}
export async function verifyPassword(password: string, stored: string) {
  return equal(await passwordHash(password, stored.split(':')[2]), stored);
}
export async function rateLimit(db: D1Database, key: string, limit = 120) {
  const window = Math.floor(Date.now() / 60000);
  const row = await db
    .prepare(
      'INSERT INTO rate_limits(key,window,count) VALUES (?,?,1) ON CONFLICT(key,window) DO UPDATE SET count=count+1 RETURNING count',
    )
    .bind(key, window)
    .first<{ count: number }>();
  if (row && row.count > limit) fail(429, 'rate_limited', 'Too many requests; retry in one minute');
}
export async function authenticate(request: Request, env: Env): Promise<Actor> {
  const bearer = request.headers.get('authorization');
  if (bearer) {
    if (!bearer.startsWith('Bearer ')) fail(401, 'unauthorized', 'Bearer credential required');
    const record = await env.DB.prepare(
      "SELECT * FROM api_credentials WHERE hash=? AND status='active' AND (expires_at IS NULL OR expires_at>?)",
    )
      .bind(await hash(bearer.slice(7)), now())
      .first<{ id: string; site_id: string | null; scopes: string; type: string }>();
    if (!record) return fail(401, 'unauthorized', 'Invalid or expired credential');
    await rateLimit(env.DB, `api:${record.id}`);
    await env.DB.prepare('UPDATE api_credentials SET last_used=? WHERE id=?')
      .bind(now(), record.id)
      .run();
    const scopes = JSON.parse(record.scopes) as string[];
    return {
      id: record.id,
      type: 'api',
      superAdmin: record.type === 'system' && scopes.includes('system:admin'),
      scopes,
      siteId: record.site_id ?? undefined,
    };
  }
  const cookieName = env.ENVIRONMENT === 'production' ? '__Host-penlum' : 'penlum_session';
  const token = request.headers
    .get('cookie')
    ?.split(';')
    .map((x) => x.trim())
    .find((x) => x.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  if (!token) return fail(401, 'unauthorized', 'Please sign in');
  const user = await env.DB.prepare(
    "SELECT u.id,u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.status='active'",
  )
    .bind(await hash(token), now())
    .first<{ id: string; role: string }>();
  if (!user) return fail(401, 'unauthorized', 'Session expired');
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
    request.headers.get('origin') !== new URL(request.url).origin
  )
    fail(403, 'csrf', 'Same-origin request required');
  await rateLimit(env.DB, `user:${user.id}`, 240);
  return {
    id: user.id,
    type: 'user',
    superAdmin: user.role === 'super_admin',
    scopes: [],
    session: true,
  };
}
export async function authorize(database: Database, actor: Actor, scope: string, siteId?: string) {
  if (actor.type === 'system') return;
  if (actor.type === 'api' || actor.type === 'mcp') {
    if (!actor.scopes.includes(scope) && !actor.superAdmin)
      fail(403, 'scope_denied', `Missing scope: ${scope}`);
    if (actor.siteId && actor.siteId !== siteId)
      fail(403, 'tenant_denied', 'Credential cannot access this site');
    if (!siteId && scope === 'system:admin' && !actor.superAdmin)
      fail(403, 'forbidden', 'System administrator required');
    return;
  }
  if (actor.superAdmin) return;
  if (!siteId) return fail(403, 'forbidden', 'System administrator required');
  const membership = await database.db
    .prepare('SELECT role FROM site_memberships WHERE site_id=? AND user_id=?')
    .bind(siteId, actor.id)
    .first<{ role: string }>();
  if (!membership || !roleScopes[membership.role]?.includes(scope))
    fail(403, 'tenant_denied', 'You do not have permission for this site');
}
export async function isAuthor(database: Database, actor: Actor, siteId: string) {
  if (actor.superAdmin || actor.type !== 'user') return false;
  return (
    (
      await database.db
        .prepare('SELECT role FROM site_memberships WHERE site_id=? AND user_id=?')
        .bind(siteId, actor.id)
        .first<{ role: string }>()
    )?.role === 'author'
  );
}
