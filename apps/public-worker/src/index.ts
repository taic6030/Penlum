import { postInput, seoInput } from '../../../packages/api-contracts/src/index';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z, ZodError } from 'zod';
import { Service } from '../../../packages/domain/src/service';
import {
  authenticate,
  verifyPassword,
  rateLimit,
  roleScopes,
} from '../../../packages/auth/src/index';
import {
  AppError,
  fail,
  id,
  hash,
  now,
  normalizeHost,
  safeURL,
  type Env,
  type Job,
} from '../../../packages/shared/src/index';
import { publicRequest } from './public';
import { mcp } from '../../mcp/src/index';
import { upload } from '../../../packages/domain/src/media';
import { executeJob, scheduled, exportTenant } from '../../../packages/domain/src/jobs';
import { performance, period } from '../../../packages/analytics/src/index';
import { render } from '../../../packages/renderer/src/index';
import { internalLinks, renderMarkdown } from '../../../packages/content/src/index';
const app = new Hono<{ Bindings: Env; Variables: { service: Service; requestId: string } }>();
const limit = (value: string | undefined, max = 100) =>
  Math.max(1, Math.min(max, Number(value) || 50));
app.use('*', async (c, next) => {
  c.set('requestId', id());
  const start = Date.now();
  await next();
  c.header('x-request-id', c.get('requestId'));
  c.header('x-content-type-options', 'nosniff');
  if (c.env.ENVIRONMENT === 'production') c.header('strict-transport-security', 'max-age=31536000');
  console.log(
    JSON.stringify({
      request_id: c.get('requestId'),
      method: c.req.method,
      status: c.res.status,
      duration_ms: Date.now() - start,
    }),
  );
});
app.use(
  '*',
  bodyLimit({
    maxSize: 12 * 1024 * 1024,
    onError: (c) =>
      c.json(
        {
          error: { code: 'body_too_large', message: 'Request exceeds 12 MB' },
          request_id: c.get('requestId'),
        },
        413,
      ),
  }),
);
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  const control = /^\/(api|admin|mcp)(\/|$)/.test(url.pathname);
  if (control && normalizeHost(url.host) !== c.env.ADMIN_HOST) return c.text('Not found', 404);
  if (control && c.env.ENVIRONMENT === 'production' && url.protocol !== 'https:')
    return c.redirect('https://' + c.env.ADMIN_HOST + url.pathname + url.search, 301);
  if (url.pathname === '/mcp' && c.req.header('origin') && c.req.header('origin') !== url.origin)
    fail(403, 'origin_denied', 'Untrusted MCP origin');
  await next();
  if (control) {
    c.header('cache-control', 'no-store');
    c.header('x-robots-tag', 'noindex');
  }
});
app.onError((error, c) => {
  if (error instanceof SyntaxError)
    return c.json(
      { error: { code: 'invalid_json', message: 'Invalid JSON' }, request_id: c.get('requestId') },
      400,
    );
  if (error instanceof ZodError)
    return c.json(
      {
        error: { code: 'validation', message: 'Invalid input', details: error.issues },
        request_id: c.get('requestId'),
      },
      422,
    );
  if (error instanceof AppError)
    return c.json(
      { error: { code: error.code, message: error.message }, request_id: c.get('requestId') },
      error.status as 400,
    );
  console.error(
    JSON.stringify({
      request_id: c.get('requestId'),
      error: error instanceof Error ? error.name : 'UnknownError',
    }),
  );
  return c.json(
    {
      error: { code: 'internal_error', message: 'Operation failed' },
      request_id: c.get('requestId'),
    },
    500,
  );
});
app.post('/api/v1/auth/login', async (c) => {
  if (c.req.header('origin') !== new URL(c.req.url).origin)
    fail(403, 'csrf', 'Same-origin login required');
  await rateLimit(c.env.DB, 'login:' + (c.req.header('cf-connecting-ip') || 'local'), 10);
  const data = z
    .object({ email: z.email(), password: z.string().min(1).max(128) })
    .parse(await c.req.json());
  const user = await c.env.DB.prepare("SELECT * FROM users WHERE email=? AND status='active'")
    .bind(data.email.toLowerCase())
    .first<{ id: string; password_hash: string; role: string; display_name: string }>();
  const valid = await verifyPassword(
    data.password,
    user?.password_hash || 'pbkdf2:100000:invalid:invalid',
  );
  if (!user || !valid) fail(401, 'invalid_login', 'Email hoặc mật khẩu không đúng');
  const token = id() + id();
  const expires = new Date(Date.now() + 8 * 3600000).toISOString();
  const service = new Service(
    c.env,
    { id: user!.id, type: 'user', superAdmin: user!.role === 'super_admin', scopes: [] },
    c.get('requestId'),
  );
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO sessions VALUES (?,?,?)').bind(
      await hash(token),
      user!.id,
      expires,
    ),
    c.env.DB.prepare('UPDATE users SET last_login=? WHERE id=?').bind(now(), user!.id),
    service.audit(null, 'auth.login', user!.id, null, {}),
  ]);
  c.header(
    'Set-Cookie',
    `${c.env.ENVIRONMENT === 'production' ? '__Host-penlum' : 'penlum_session'}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=28800${c.env.ENVIRONMENT === 'production' ? '; Secure' : ''}`,
  );
  return c.json({
    data: {
      id: user!.id,
      display_name: user!.display_name,
      super_admin: user!.role === 'super_admin',
    },
    request_id: c.get('requestId'),
  });
});
const protectedRoute = async (
  c: Context<{ Bindings: Env; Variables: { service: Service; requestId: string } }>,
  next: () => Promise<void>,
) => {
  const actor = await authenticate(c.req.raw, c.env);
  c.set('service', new Service(c.env, actor, c.get('requestId')));
  let key: string | undefined;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && c.req.path !== '/mcp') {
    key = c.req.header('idempotency-key');
    if (key) {
      if (key.length > 128) fail(422, 'idempotency_key', 'Key is too long');
      const body = await c.req.raw.clone().arrayBuffer();
      const fingerprint = await hash(c.req.method + c.req.path + (await hash(body)));
      await c.env.DB.prepare(
        'DELETE FROM idempotency_keys WHERE actor_id=? AND key=? AND expires_at<?',
      )
        .bind(actor.id, key, now())
        .run();
      const inserted = await c.env.DB.prepare(
        'INSERT OR IGNORE INTO idempotency_keys(actor_id,key,request_hash,expires_at) VALUES (?,?,?,?)',
      )
        .bind(actor.id, key, fingerprint, new Date(Date.now() + 86400000).toISOString())
        .run();
      if (!inserted.meta.changes) {
        const stored = await c.env.DB.prepare(
          'SELECT * FROM idempotency_keys WHERE actor_id=? AND key=?',
        )
          .bind(actor.id, key)
          .first<{ request_hash: string; response: string; status: number }>();
        if (stored?.request_hash !== fingerprint)
          fail(409, 'idempotency_mismatch', 'Key reused for different input');
        if (!stored?.status)
          fail(409, 'request_in_progress', 'Request is in progress or requires reconciliation');
        return new Response(stored!.response, {
          status: stored!.status,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'x-request-id': c.get('requestId'),
          },
        });
      }
    }
  }
  await next();
  if (key) {
    if (c.res.status < 400)
      await c.env.DB.prepare(
        'UPDATE idempotency_keys SET response=?,status=? WHERE actor_id=? AND key=?',
      )
        .bind(await c.res.clone().text(), c.res.status, actor.id, key)
        .run();
    else if (c.res.status < 500)
      await c.env.DB.prepare('DELETE FROM idempotency_keys WHERE actor_id=? AND key=?')
        .bind(actor.id, key)
        .run();
  }
};
app.use('/api/v1/*', protectedRoute);
app.use('/mcp', protectedRoute);
const ok = (c: any, data: unknown, status = 200) =>
  c.json({ data, request_id: c.get('requestId') }, status);
const page = (c: any, data: { id?: unknown }[]) =>
  c.json({
    data,
    next_cursor: data.length === limit(c.req.query('limit')) ? data.at(-1)?.id : null,
    request_id: c.get('requestId'),
  });
app.get('/api/v1/auth/me', async (c) => {
  const actor = c.get('service').actor;
  const memberships =
    actor.type === 'user'
      ? (
          await c.env.DB.prepare('SELECT site_id,role FROM site_memberships WHERE user_id=?')
            .bind(actor.id)
            .all<{ site_id: string; role: string }>()
        ).results
      : [];
  const user =
    actor.type === 'user'
      ? await c.env.DB.prepare('SELECT display_name,email FROM users WHERE id=?')
          .bind(actor.id)
          .first()
      : null;
  return ok(c, {
    ...actor,
    ...user,
    memberships: memberships.map((m) => ({ ...m, scopes: roleScopes[m.role] || [] })),
  });
});
app.post('/api/v1/auth/logout', async (c) => {
  const cookieName = c.env.ENVIRONMENT === 'production' ? '__Host-penlum' : 'penlum_session';
  const token = c.req
    .header('cookie')
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith(cookieName + '='))
    ?.slice(cookieName.length + 1);
  if (token)
    await c.env.DB.prepare('DELETE FROM sessions WHERE id_hash=?')
      .bind(await hash(token))
      .run();
  c.header(
    'Set-Cookie',
    `${cookieName}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${c.env.ENVIRONMENT === 'production' ? '; Secure' : ''}`,
  );
  return ok(c, { ok: true });
});
app.get('/api/v1/sites', async (c) =>
  page(c, await c.get('service').listSites(limit(c.req.query('limit')), c.req.query('cursor'))),
);
app.post('/api/v1/sites', async (c) =>
  ok(c, await c.get('service').createSite(await c.req.json()), 201),
);
app.post('/api/v1/sites/bulk', async (c) => {
  const service = c.get('service');
  await service.access('system:admin');
  const data = z
    .object({
      site_ids: z.array(z.string()).min(1).max(100),
      action: z.enum(['activate', 'archive', 'audit', 'purge', 'export', 'theme']),
      theme_id: z.enum(['journal', 'editorial', 'minimal']).optional(),
    })
    .strict()
    .parse(await c.req.json());
  if (data.action === 'theme' && !data.theme_id) fail(422, 'theme', 'Select a theme');
  const results = [];
  for (const sid of new Set(data.site_ids)) {
    try {
      if (data.action === 'activate' || data.action === 'archive')
        await service.siteStatus(sid, data.action === 'activate' ? 'active' : 'archived');
      else if (data.action === 'theme') {
        const site = await service.getSite(sid);
        await service.updateSite(sid, { version: site!.version, theme_id: data.theme_id });
      } else await service.enqueue(data.action, sid);
      results.push({ site_id: sid, ok: true });
    } catch (error) {
      results.push({
        site_id: sid,
        ok: false,
        error: error instanceof Error ? error.message : 'Operation failed',
      });
    }
  }
  return ok(c, results);
});
app.get('/api/v1/content', async (c) => {
  const s = c.get('service'),
    a = s.actor;
  let clause = '',
    args: unknown[] = [];
  if (a.type === 'user' && !a.superAdmin) {
    clause =
      "AND EXISTS (SELECT 1 FROM site_memberships m WHERE m.site_id=p.site_id AND m.user_id=? AND (m.role!='author' OR p.author_id=?))";
    args = [a.id, a.id];
  } else {
    await s.access('content:read', a.siteId);
    if (a.siteId) {
      clause = 'AND p.site_id=?';
      args = [a.siteId];
    }
  }
  const q = c.req.query('q') || '';
  const rows = (
    await c.env.DB.prepare(
      `SELECT p.*,s.name site_name FROM posts p JOIN sites s ON s.id=p.site_id WHERE p.deleted_at IS NULL AND p.id>? AND (p.title LIKE ? OR p.slug LIKE ?) ${clause} ORDER BY p.id LIMIT ?`,
    )
      .bind(
        c.req.query('cursor') || '',
        '%' + q + '%',
        '%' + q + '%',
        ...args,
        limit(c.req.query('limit')),
      )
      .all()
  ).results;
  return page(c, rows);
});
app.get('/api/v1/sites/:site', async (c) =>
  ok(c, await c.get('service').getSite(c.req.param('site'))),
);
app.patch('/api/v1/sites/:site', async (c) =>
  ok(c, await c.get('service').updateSite(c.req.param('site'), await c.req.json())),
);
app.post('/api/v1/sites/:site/activate', async (c) =>
  ok(c, await c.get('service').siteStatus(c.req.param('site'), 'active')),
);
app.post('/api/v1/sites/:site/archive', async (c) =>
  ok(c, await c.get('service').siteStatus(c.req.param('site'), 'archived')),
);
app.get('/api/v1/sites/:site/domains', async (c) =>
  ok(c, await c.get('service').domains(c.req.param('site'))),
);
app.post('/api/v1/sites/:site/domains', async (c) =>
  ok(c, await c.get('service').addDomain(c.req.param('site'), await c.req.json()), 201),
);
app.post('/api/v1/sites/:site/domains/:domain/verify', async (c) =>
  ok(c, await c.get('service').verifyDomain(c.req.param('site'), c.req.param('domain'))),
);
app.delete('/api/v1/sites/:site/domains/:domain', async (c) =>
  ok(c, await c.get('service').deleteDomain(c.req.param('site'), c.req.param('domain'))),
);
app.get('/api/v1/sites/:site/posts', async (c) =>
  page(
    c,
    await c
      .get('service')
      .listPosts(
        c.req.param('site'),
        limit(c.req.query('limit')),
        c.req.query('cursor'),
        c.req.query('status'),
        c.req.query('q'),
      ),
  ),
);
app.post('/api/v1/sites/:site/posts', async (c) =>
  ok(c, await c.get('service').createPost(c.req.param('site'), await c.req.json()), 201),
);
app.get('/api/v1/sites/:site/posts/:post', async (c) =>
  ok(c, await c.get('service').getPost(c.req.param('site'), c.req.param('post'))),
);
app.patch('/api/v1/sites/:site/posts/:post', async (c) =>
  ok(
    c,
    await c.get('service').updatePost(c.req.param('site'), c.req.param('post'), await c.req.json()),
  ),
);
app.delete('/api/v1/sites/:site/posts/:post', async (c) =>
  ok(c, await c.get('service').unpublish(c.req.param('site'), c.req.param('post'), true)),
);
app.post('/api/v1/sites/:site/posts/:post/publish', async (c) =>
  ok(
    c,
    await c.get('service').publish(c.req.param('site'), c.req.param('post'), await c.req.json()),
  ),
);
app.post('/api/v1/sites/:site/posts/:post/unpublish', async (c) =>
  ok(c, await c.get('service').unpublish(c.req.param('site'), c.req.param('post'))),
);
// Unsaved preview never mutates a published post or bumps its cache generation.
app.post('/api/v1/sites/:site/preview', async (c) => {
  const service = c.get('service'),
    siteId = c.req.param('site');
  await service.access('content:read', siteId);
  const data = z
    .object({ post_id: z.string().optional(), post: postInput, seo: seoInput.optional() })
    .strict()
    .parse(await c.req.json());
  const saved = data.post_id ? await service.getPost(siteId, data.post_id) : null;
  const site = (await service.database.site(siteId))!;
  const post = {
    id: saved?.id || 'preview',
    site_id: siteId,
    author_id: service.actor.id,
    status: 'draft' as const,
    published_at: saved?.published_at || null,
    scheduled_at: null,
    version: 0,
    created_at: now(),
    updated_at: now(),
    deleted_at: null,
    ...data.post,
    featured_media: data.post.featured_media || null,
  };
  const repo = service.database.forSite(siteId);
  const media = await repo.all<{ id: string; width: number; height: number }>('media', 2000);
  const featured = post.featured_media
    ? await repo
        .statement(
          'SELECT id,alt,width,height FROM media WHERE site_id=? AND id=?',
          post.featured_media,
        )
        .first<{ id: string; alt: string; width: number; height: number }>()
    : null;
  const settings = await repo
    .statement('SELECT settings FROM theme_settings WHERE site_id=?')
    .first<{ settings: string }>();
  const navigation = (
    await repo
      .statement(
        "SELECT label,url FROM navigation_items WHERE site_id=? AND menu_id IN (SELECT id FROM navigation_menus WHERE site_id=? AND name='main') ORDER BY position",
        siteId,
      )
      .all<{ label: string; url: string }>()
  ).results;
  const result = await render({
    site,
    post,
    path: '/' + post.slug,
    kind: post.type === 'post' ? 'posts' : 'pages',
    seo: data.seo
      ? { ...data.seo, noindex: Number(data.seo.noindex), nofollow: Number(data.seo.nofollow) }
      : {},
    snippets: [],
    navigation,
    noindex: true,
    media,
    featured: featured || undefined,
    settings: JSON.parse(settings?.settings || '{}'),
  });
  const html = result.html.replace(
    /src="\/media\/([^"]+)"/g,
    `src="${new URL(c.req.url).origin}/api/v1/sites/${siteId}/media/$1/file"`,
  );
  return new Response(html, {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy': result.csp.replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    },
  });
});
app.get('/api/v1/sites/:site/posts/:post/preview', async (c) => {
  const s = c.get('service');
  const post = await s.getPost(c.req.param('site'), c.req.param('post'));
  const site = (await s.database.site(post.site_id))!;
  const data = await render({
    site,
    post,
    path: '/' + post.slug,
    kind: post.type === 'post' ? 'posts' : 'pages',
    snippets: [],
    navigation: [],
    noindex: true,
  });
  return new Response(data.html, {
    headers: {
      'content-type': 'text/html;charset=utf-8',
      'cache-control': 'no-store',
      'x-robots-tag': 'noindex',
      'content-security-policy': data.csp.replace(
        "frame-ancestors 'none'",
        "frame-ancestors 'self'",
      ),
    },
  });
});
app.get('/api/v1/sites/:site/posts/:post/helpers', async (c) => {
  const s = c.get('service');
  const post = await s.getPost(c.req.param('site'), c.req.param('post'));
  const site = (await s.database.site(post.site_id))!;
  const posts = await s.listPosts(site.id, 100);
  const paths = internalLinks(post.markdown_content, site.primary_domain);
  return ok(c, {
    headings: renderMarkdown(post.markdown_content).headings,
    links: paths,
    broken: paths.filter(
      (p) => p !== '/' && !posts.some((x) => '/' + x.slug === p && x.status === 'published'),
    ),
    suggestions: posts
      .filter((p) => p.id !== post.id && p.status === 'published' && !paths.includes('/' + p.slug))
      .slice(0, 10)
      .map((p) => ({ title: p.title, path: '/' + p.slug })),
  });
});
app.get('/api/v1/sites/:site/seo/:entity', async (c) =>
  ok(c, await c.get('service').seo(c.req.param('site'), c.req.param('entity'))),
);
app.put('/api/v1/sites/:site/seo/:entity', async (c) =>
  ok(c, await c.get('service').seo(c.req.param('site'), c.req.param('entity'), await c.req.json())),
);
for (const resource of [
  'categories',
  'media',
  'redirects',
  'code_snippets',
  'seo_audit_results',
  'theme_settings',
  'navigation_menus',
  'navigation_items',
  'analytics_sync_state',
] as const)
  app.get(`/api/v1/sites/:site/${resource}`, async (c) =>
    ok(
      c,
      await c
        .get('service')
        .listResource(
          c.req.param('site'),
          resource,
          limit(c.req.query('limit')),
          c.req.query('cursor'),
        ),
    ),
  );
app.post('/api/v1/sites/:site/categories', async (c) =>
  ok(c, await c.get('service').category(c.req.param('site'), await c.req.json()), 201),
);
app.put('/api/v1/sites/:site/categories/:item', async (c) =>
  ok(
    c,
    await c.get('service').category(c.req.param('site'), await c.req.json(), c.req.param('item')),
  ),
);
app.post('/api/v1/sites/:site/redirects', async (c) =>
  ok(c, await c.get('service').redirect(c.req.param('site'), await c.req.json()), 201),
);
app.put('/api/v1/sites/:site/redirects/:item', async (c) =>
  ok(
    c,
    await c.get('service').redirect(c.req.param('site'), await c.req.json(), c.req.param('item')),
  ),
);
for (const resource of ['categories', 'media', 'redirects'] as const)
  app.delete(`/api/v1/sites/:site/${resource}/:item`, async (c) =>
    ok(
      c,
      await c.get('service').deleteResource(c.req.param('site'), resource, c.req.param('item')),
    ),
  );
app.post('/api/v1/sites/:site/media', async (c) => {
  const data = await c.req.formData();
  const file = data.get('file');
  if (!(file instanceof File)) fail(422, 'file', 'File required');
  return ok(
    c,
    await upload(
      c.get('service'),
      c.req.param('site'),
      file as File,
      String(data.get('alt') || ''),
    ),
    201,
  );
});
app.patch('/api/v1/sites/:site/media/:item', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('media:write', sid);
  const data = z
    .object({
      alt: z.string().max(1000),
      title: z.string().max(1000).default(''),
      caption: z.string().max(1000).default(''),
    })
    .strict()
    .parse(await c.req.json());
  const before = await s.database
    .forSite(sid)
    .statement('SELECT * FROM media WHERE site_id=? AND id=?', c.req.param('item'))
    .first();
  if (!before) fail(404, 'not_found', 'Media not found');
  await s.commit(
    [
      c.env.DB.prepare('UPDATE media SET alt=?,title=?,caption=? WHERE site_id=? AND id=?').bind(
        data.alt,
        data.title,
        data.caption,
        sid,
        c.req.param('item'),
      ),
      s.audit(sid, 'media.update', c.req.param('item'), before, data),
    ],
    sid,
  );
  return ok(c, data);
});
app.get('/api/v1/sites/:site/media/:item/file', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('content:read', sid);
  const media = await s.database
    .forSite(sid)
    .statement('SELECT * FROM media WHERE site_id=? AND id=?', c.req.param('item'))
    .first<{ r2_key: string; mime: string }>();
  if (!media) fail(404, 'not_found', 'Media not found');
  const object = await c.env.MEDIA.get(media!.r2_key);
  if (!object) fail(404, 'not_found', 'Media file not found');
  return new Response(object!.body, {
    headers: {
      'content-type': media!.mime,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
});
for (const type of ['audit', 'export', 'purge'] as const)
  app.post(`/api/v1/sites/:site/${type}`, async (c) =>
    ok(c, await c.get('service').enqueue(type, c.req.param('site')), 202),
  );
app.get('/api/v1/sites/:site/export', async (c) => {
  await c.get('service').access('sites:write', c.req.param('site'));
  return ok(c, await exportTenant(c.env, c.req.param('site')));
});
app.get('/api/v1/sites/:site/health', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('sites:read', sid);
  return ok(c, {
    site: await s.database.site(sid),
    domains: await s.domains(sid),
    issues: await s.database.forSite(sid).all('seo_audit_results', 100),
  });
});
app.post('/api/v1/sites/:site/snippets', async (c) =>
  ok(c, await c.get('service').snippet(c.req.param('site'), await c.req.json()), 201),
);
app.put('/api/v1/sites/:site/snippets/:item', async (c) =>
  ok(
    c,
    await c.get('service').snippet(c.req.param('site'), await c.req.json(), c.req.param('item')),
  ),
);
app.get('/api/v1/system/snippets', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT * FROM code_snippets WHERE site_id IS NULL ORDER BY priority,id LIMIT 100',
      ).all()
    ).results,
  );
});
app.post('/api/v1/system/snippets', async (c) =>
  ok(c, await c.get('service').snippet(null, await c.req.json()), 201),
);
app.put('/api/v1/system/snippets/:item', async (c) =>
  ok(c, await c.get('service').snippet(null, await c.req.json(), c.req.param('item'))),
);
app.get('/api/v1/system/snippets/:item/revisions', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT * FROM snippet_revisions WHERE snippet_id=? ORDER BY version DESC LIMIT 100',
      )
        .bind(c.req.param('item'))
        .all()
    ).results,
  );
});
app.post('/api/v1/system/snippets/:item/rollback', async (c) => {
  const s = c.get('service');
  await s.access('system:admin');
  const data = z
    .object({
      revision_id: z.string(),
      version: z.number().int(),
      confirmation: z.literal('APPLY GLOBAL CODE'),
    })
    .parse(await c.req.json());
  const revision = await c.env.DB.prepare(
    'SELECT body FROM snippet_revisions WHERE snippet_id=? AND id=?',
  )
    .bind(c.req.param('item'), data.revision_id)
    .first<{ body: string }>();
  if (!revision) fail(404, 'not_found', 'Revision not found');
  const old = JSON.parse(revision!.body);
  return ok(
    c,
    await s.snippet(
      null,
      {
        name: old.name,
        placement: old.placement,
        targeting: JSON.parse(old.targeting),
        priority: old.priority,
        enabled: !!old.enabled,
        executable: !!old.executable,
        content: old.content,
        version: data.version,
        confirmation: data.confirmation,
      },
      c.req.param('item'),
    ),
  );
});
app.get('/api/v1/users', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT id,email,display_name,role,status,last_login FROM users ORDER BY email LIMIT 1000',
      ).all()
    ).results,
  );
});
app.post('/api/v1/users', async (c) =>
  ok(c, await c.get('service').createUser(await c.req.json()), 201),
);
app.get('/api/v1/sites/:site/members', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('users:read', sid);
  return ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT m.*,u.email,u.display_name FROM site_memberships m JOIN users u ON u.id=m.user_id WHERE m.site_id=?',
      )
        .bind(sid)
        .all()
    ).results,
  );
});
app.post('/api/v1/sites/:site/members', async (c) =>
  ok(c, await c.get('service').membership(c.req.param('site'), await c.req.json())),
);
app.delete('/api/v1/sites/:site/members/:user', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('users:write', sid);
  const before = await c.env.DB.prepare(
    'SELECT * FROM site_memberships WHERE site_id=? AND user_id=?',
  )
    .bind(sid, c.req.param('user'))
    .first();
  await s.commit([
    c.env.DB.prepare('DELETE FROM site_memberships WHERE site_id=? AND user_id=?').bind(
      sid,
      c.req.param('user'),
    ),
    s.audit(sid, 'membership.delete', c.req.param('user'), before, null),
  ]);
  return ok(c, { ok: true });
});
app.get('/api/v1/credentials', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (
      await c.env.DB.prepare(
        'SELECT id,name,type,site_id,scopes,status,expires_at,last_used FROM api_credentials ORDER BY created_at DESC LIMIT 1000',
      ).all()
    ).results,
  );
});
app.post('/api/v1/credentials', async (c) =>
  ok(c, await c.get('service').credential(await c.req.json()), 201),
);
app.delete('/api/v1/credentials/:item', async (c) => {
  const s = c.get('service');
  await s.access('system:admin');
  await s.commit([
    c.env.DB.prepare("UPDATE api_credentials SET status='revoked' WHERE id=?").bind(
      c.req.param('item'),
    ),
    s.audit(null, 'credential.revoke', c.req.param('item'), null, { status: 'revoked' }),
  ]);
  return ok(c, { ok: true });
});
app.put('/api/v1/sites/:site/theme', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('sites:write', sid);
  const data = z
    .object({
      container: z.enum(['narrow', 'wide']).optional(),
      typography: z.enum(['serif', 'sans']).optional(),
      spacing: z.enum(['compact', 'comfortable']).optional(),
    })
    .strict()
    .parse(await c.req.json());
  const before = await s.database
    .forSite(sid)
    .statement('SELECT settings FROM theme_settings WHERE site_id=?')
    .first();
  await s.commit(
    [
      c.env.DB.prepare(
        'INSERT INTO theme_settings VALUES (?,?) ON CONFLICT(site_id) DO UPDATE SET settings=excluded.settings',
      ).bind(sid, JSON.stringify(data)),
      s.audit(sid, 'theme.update', sid, before, data),
    ],
    sid,
  );
  return ok(c, data);
});
app.put('/api/v1/sites/:site/navigation', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('sites:write', sid);
  const data = z
    .array(z.object({ label: z.string().min(1).max(100), url: z.string().max(1000) }).strict())
    .max(20)
    .parse(await c.req.json());
  data.forEach((n) => safeURL(n.url));
  const menu = await s.database
    .forSite(sid)
    .statement("SELECT id FROM navigation_menus WHERE site_id=? AND name='main'")
    .first<{ id: string }>();
  if (!menu) fail(404, 'not_found', 'Main menu not found');
  const before = await s.database.forSite(sid).all('navigation_items');
  await s.commit(
    [
      c.env.DB.prepare('DELETE FROM navigation_items WHERE site_id=? AND menu_id=?').bind(
        sid,
        menu!.id,
      ),
      ...data.map((n, i) =>
        c.env.DB.prepare('INSERT INTO navigation_items VALUES (?,?,?,?,?,?)').bind(
          id(),
          sid,
          menu!.id,
          n.label,
          n.url,
          i,
        ),
      ),
      s.audit(sid, 'navigation.update', menu!.id, before, data),
    ],
    sid,
  );
  return ok(c, data);
});
app.get('/api/v1/analytics/:mode', async (c) => {
  const start =
      c.req.query('start') || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10),
    end = c.req.query('end') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const data = await performance(
    c.env,
    c.get('service').actor,
    start,
    end,
    undefined,
    'sites',
    Math.max(0, Math.min(100000, Number(c.req.query('minimum') || 10))),
  );
  const mode = c.req.param('mode');
  return ok(c, mode === 'winners' ? data.winners : mode === 'losers' ? data.losers : data);
});
app.get('/api/v1/sites/:site/analytics/:mode', async (c) => {
  const sid = c.req.param('site'),
    s = c.get('service');
  await s.access('analytics:read', sid);
  const mode = c.req.param('mode');
  const start =
      c.req.query('start') || new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10),
    end = c.req.query('end') || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  period(start, end);
  if (mode === 'queries')
    return ok(c, { available: false, reason: 'Query aggregates are deferred to V1.1' });
  if (mode === 'daily')
    return ok(
      c,
      (
        await c.env.DB.prepare(
          'SELECT * FROM analytics_daily_site WHERE site_id=? AND date BETWEEN ? AND ? ORDER BY date',
        )
          .bind(sid, start, end)
          .all()
      ).results,
    );
  return ok(
    c,
    await performance(c.env, s.actor, start, end, sid, mode === 'pages' ? 'pages' : 'sites'),
  );
});
app.put('/api/v1/sites/:site/analytics', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('system:admin');
  await s.access('sites:write', sid);
  const data = z.object({ property: z.string().min(1).max(500) }).parse(await c.req.json());
  const site = (await s.database.site(sid))!;
  if (
    data.property !== `sc-domain:${site.primary_domain}` &&
    data.property !== `https://${site.primary_domain}/`
  )
    fail(422, 'property_scope', 'Property must match the primary domain');
  await s.commit([
    c.env.DB.prepare(
      'INSERT INTO analytics_sync_state(site_id,property) VALUES (?,?) ON CONFLICT(site_id) DO UPDATE SET property=excluded.property',
    ).bind(sid, data.property),
    s.audit(sid, 'analytics.connect', sid, null, data),
  ]);
  return ok(c, data);
});
app.post('/api/v1/sites/:site/analytics/sync', async (c) => {
  const s = c.get('service'),
    sid = c.req.param('site');
  await s.access('system:admin');
  await s.access('sites:write', sid);
  const job: Job = { id: id(), site_id: sid, type: 'analytics' };
  await s.commit([
    c.env.DB.prepare(
      'INSERT INTO jobs(id,site_id,type,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).bind(job.id, sid, job.type, JSON.stringify(job), now(), now()),
    s.audit(sid, 'analytics.sync', job.id, null, job),
  ]);
  try {
    await c.env.JOBS.send(job);
  } catch {}
  return ok(c, job, 202);
});
app.get('/api/v1/system/health', async (c) => {
  await c.get('service').access('system:admin');
  const db = await c.env.DB.prepare('SELECT 1 ok').first();
  let r2 = 'ok';
  try {
    await c.env.MEDIA.list({ limit: 1 });
  } catch {
    r2 = 'error';
  }
  return ok(c, {
    runtime: 'Cloudflare Workers',
    environment: c.env.ENVIRONMENT,
    database: db ? 'ok' : 'error',
    r2,
    queues: 'binding configured; inspect jobs for delivery status',
    state: (await c.env.DB.prepare('SELECT * FROM system_state').all()).results,
    failed_jobs: await c.env.DB.prepare(
      "SELECT count(*) count FROM jobs WHERE status='failed'",
    ).first(),
    analytics: (await c.env.DB.prepare('SELECT * FROM analytics_sync_state LIMIT 1000').all())
      .results,
  });
});
app.get('/api/v1/system/jobs', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (await c.env.DB.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT 100').all()).results,
  );
});
app.post('/api/v1/system/jobs/:item/retry', async (c) => {
  const s = c.get('service');
  await s.access('system:admin');
  await s.commit([
    c.env.DB.prepare(
      "UPDATE jobs SET status='queued',updated_at=? WHERE id=? AND status='failed'",
    ).bind(now(), c.req.param('item')),
    s.audit(null, 'job.retry', c.req.param('item'), null, {}),
  ]);
  return ok(c, { queued: true });
});
app.get('/api/v1/system/audit', async (c) => {
  await c.get('service').access('system:admin');
  return ok(
    c,
    (await c.env.DB.prepare('SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT 100').all())
      .results,
  );
});
app.all('/mcp', (c) => mcp(c.req.raw, c.get('service')));
app.all('/api/*', (c) =>
  c.json(
    {
      error: { code: 'not_found', message: 'API route not found' },
      request_id: c.get('requestId'),
    },
    404,
  ),
);
app.get('/admin', (c) => c.redirect('/admin/'));
app.get('/admin/*', async (c) => {
  const url = new URL(c.req.url);
  const response = await c.env.ADMIN_ASSETS.fetch(new Request(url, c.req.raw));
  const headers = new Headers(response.headers);
  headers.set(
    'content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' blob: data: https:; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
});
app.all('*', (c) => publicRequest(c.req.raw, c.env, c.executionCtx));
export default {
  fetch: app.fetch,
  async scheduled(event: ScheduledController, env: Env) {
    await scheduled(env, event.cron);
  },
  async queue(batch: MessageBatch<Job>, env: Env) {
    for (const message of batch.messages) {
      try {
        await executeJob(env, message.body);
        message.ack();
      } catch {
        message.retry({ delaySeconds: 60 });
      }
    }
  },
} satisfies ExportedHandler<Env, Job>;
export { app };
