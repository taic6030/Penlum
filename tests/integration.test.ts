import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { Miniflare } from 'miniflare';
import { readFileSync } from 'node:fs';
import { Service } from '../packages/domain/src/service';
import { exportTenant, executeJob, scheduled, systemActor } from '../packages/domain/src/jobs';
import { Database, type Actor, type Site, type Post } from '../packages/db/src/index';
import { hash, id, now, type Env } from '../packages/shared/src/index';
import { app } from '../apps/public-worker/src/index';
import { performance, syncGSC } from '../packages/analytics/src/index';
import { upload } from '../packages/domain/src/media';
import { restoreSQL } from '../packages/domain/src/restore';
import { runAudit } from '../packages/seo/src/audit';
let mf: Miniflare,
  env: Env,
  service: Service,
  a: Site & { domain_verification: { id: string } },
  b: Site & { domain_verification: { id: string } },
  post: Post,
  token: string;
const admin: Actor = { id: 'test-admin', type: 'user', superAdmin: true, scopes: [] };
const cache = new Map<string, Response>();
const pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException() {} };
async function request(
  path: string,
  method = 'GET',
  data?: unknown,
  bearer = token,
  headers: Record<string, string> = {},
) {
  return app.fetch(
    new Request('http://localhost' + path, {
      method,
      headers: {
        ...(bearer ? { authorization: 'Bearer ' + bearer } : {}),
        ...(data ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: data ? JSON.stringify(data) : undefined,
    }),
    env,
    ctx as any,
  );
}
async function publicGet(host: string, path = '/', method = 'GET') {
  const result = await app.fetch(
    new Request(`https://${host}${path}`, { method }),
    env,
    ctx as any,
  );
  await Promise.all(pending.splice(0));
  return result;
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-07-01',
    d1Databases: ['DB'],
    r2Buckets: ['MEDIA'],
  });
  const db = await mf.getD1Database('DB');
  const sql = readFileSync('migrations/0001_core.sql', 'utf8');
  await db.batch(
    sql
      .split(';')
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => db.prepare(x)),
  );
  env = {
    DB: db as unknown as D1Database,
    MEDIA: (await mf.getR2Bucket('MEDIA')) as unknown as R2Bucket,
    JOBS: { send: async () => {} } as unknown as Queue,
    ENVIRONMENT: 'development',
    ADMIN_HOST: 'localhost',
    ADMIN_ASSETS: { fetch: async () => new Response('admin') } as unknown as Fetcher,
  };
  Object.defineProperty(globalThis, 'caches', {
    configurable: true,
    value: {
      default: {
        match: async (r: Request) => cache.get(r.url)?.clone(),
        put: async (r: Request, response: Response) => {
          cache.set(r.url, response.clone());
        },
      },
    },
  });
  service = new Service(env, admin, id());
  a = (await service.createSite({
    name: 'Tenant A',
    primary_domain: 'a.localhost',
    site_title: 'A Journal',
  })) as typeof a;
  b = (await service.createSite({
    name: 'Tenant B',
    primary_domain: 'b.localhost',
    site_title: 'B Journal',
  })) as typeof b;
  await service.verifyDomain(a.id, a.domain_verification.id);
  await service.verifyDomain(b.id, b.domain_verification.id);
  await service.siteStatus(a.id, 'active');
  await service.siteStatus(b.id, 'active');
  await service.updateSite(a.id, {
    version: (await service.getSite(a.id))!.version,
    robots_mode: 'index',
  });
  await service.updateSite(b.id, {
    version: (await service.getSite(b.id))!.version,
    robots_mode: 'index',
  });
  token = (await service.credential({ name: 'test', type: 'system', scopes: ['system:admin'] }))
    .token;
}, 30000);
afterAll(async () => {
  await Promise.all(pending);
  await mf?.dispose();
});
describe.sequential('D1 + services + HTTP acceptance', () => {
  it('creates sites without deploying and rejects unknown hosts', async () => {
    expect((await publicGet('unknown.localhost')).status).toBe(404);
    expect((await publicGet('a.localhost')).status).toBe(200);
    expect((await publicGet('a.localhost', '/api/v1/sites')).status).toBe(404);
  });
  it('creates draft, hides it publicly, publishes SSR + SEO + sitemap', async () => {
    post = await service.createPost(a.id, {
      title: 'First article',
      slug: 'first-article',
      markdown_content: '## Introduction\n\nReadable **content**.',
      excerpt: 'A real article.',
    });
    expect((await publicGet('a.localhost', '/first-article')).status).toBe(404);
    post = await service.publish(a.id, post.id);
    const response = await publicGet('a.localhost', '/first-article');
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('<h1>First article</h1>');
    expect(html).toContain('rel="canonical" href="https://a.localhost/first-article"');
    expect(html).toContain('BlogPosting');
    expect(html).toContain('<strong>content</strong>');
    expect(html.match(/<h1>/g)).toHaveLength(1);
    expect(html).not.toContain('app.js');
    expect(new TextEncoder().encode(html).byteLength).toBeLessThan(25000);
    expect(await (await publicGet('a.localhost', '/sitemap.xml')).text()).toContain(
      '/first-article',
    );
  });
  it('serves HEAD with no body and preserves 404 and robots', async () => {
    const head = await publicGet('a.localhost', '/first-article', 'HEAD');
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    const missing = await publicGet('a.localhost', '/absent');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-robots-tag')).toBe('noindex');
    expect(await (await publicGet('b.localhost', '/robots.txt')).text()).toContain(
      'https://b.localhost/sitemap.xml',
    );
  });
  it('enforces tenant API scope for posts and refuses resource ID crossover', async () => {
    const key = await service.credential({
      name: 'site-b',
      type: 'site',
      site_id: b.id,
      scopes: ['sites:read', 'content:read', 'content:write'],
    });
    expect((await request(`/api/v1/sites/${a.id}/posts`, 'GET', undefined, key.token)).status).toBe(
      403,
    );
    expect(
      (await request(`/api/v1/sites/${b.id}/posts/${post.id}`, 'GET', undefined, key.token)).status,
    ).toBe(404);
    expect(
      (await request(`/api/v1/sites/${b.id}/posts`, 'POST', { title: 'B', slug: 'b' }, key.token))
        .status,
    ).toBe(201);
    expect(
      (await request(`/api/v1/sites/${b.id}/posts/${post.id}/publish`, 'POST', {}, key.token))
        .status,
    ).toBe(403);
  });
  it('prevents foreign categories and media from linking across tenants', async () => {
    const category = await service.category(b.id, { name: 'B category', slug: 'b-category' });
    await expect(
      service.createPost(a.id, { title: 'bad', slug: 'bad', category_ids: [category.id] }),
    ).rejects.toMatchObject({ code: 'category_scope' });
    await expect(
      service.updatePost(a.id, post.id, { version: post.version, featured_media: 'foreign-media' }),
    ).rejects.toMatchObject({ code: 'media_scope' });
  });
  it('creates 301 on slug changes, flattens prior redirects and enforces optimistic versions', async () => {
    const oldVersion = post.version;
    post = await service.updatePost(a.id, post.id, { slug: 'renamed', version: oldVersion });
    const response = await publicGet('a.localhost', '/first-article');
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe('https://a.localhost/renamed');
    await expect(
      service.updatePost(a.id, post.id, { title: 'Stale write', version: oldVersion }),
    ).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await service.getPost(a.id, post.id)).title).toBe('First article');
    post = await service.updatePost(a.id, post.id, {
      slug: 'final-article',
      version: post.version,
    });
    expect((await publicGet('a.localhost', '/first-article')).headers.get('location')).toBe(
      'https://a.localhost/final-article',
    );
  });
  it('invalidates only the mutated tenant cache generation', async () => {
    await publicGet('b.localhost');
    expect((await publicGet('b.localhost')).headers.get('x-penlum-cache')).toBe('HIT');
    const before = await service.getSite(b.id);
    post = await service.updatePost(a.id, post.id, {
      title: 'Updated title',
      version: post.version,
    });
    expect((await service.getSite(b.id))!.cache_version).toBe(before!.cache_version);
    expect((await publicGet('b.localhost')).headers.get('x-penlum-cache')).toBe('HIT');
    expect(await (await publicGet('a.localhost', '/final-article')).text()).toContain(
      'Updated title',
    );
  });
  it('excludes noindex and noncanonical pages from sitemap', async () => {
    await service.seo(a.id, post.id, { noindex: true });
    expect(await (await publicGet('a.localhost', '/sitemap.xml')).text()).not.toContain(
      '/final-article',
    );
    expect(await (await publicGet('a.localhost', '/final-article')).text()).toContain(
      'noindex,follow',
    );
    await service.seo(a.id, post.id, { canonical_override: 'https://external.example/canonical' });
    expect(await (await publicGet('a.localhost', '/sitemap.xml')).text()).not.toContain(
      '/final-article',
    );
    await service.seo(a.id, post.id, {});
  });
  it('rejects redirect loops, chains and unsafe targets', async () => {
    await service.redirect(a.id, { source_path: '/old', target: '/final-article' });
    await expect(
      service.redirect(a.id, { source_path: '/older', target: '/old' }),
    ).rejects.toMatchObject({ code: 'redirect_chain' });
    await expect(
      service.redirect(a.id, { source_path: '/self', target: '/self' }),
    ).rejects.toMatchObject({ code: 'redirect_loop' });
    await expect(
      service.redirect(a.id, { source_path: '/evil', target: 'javascript:alert(1)' }),
    ).rejects.toThrow();
  });
  it('requires global code confirmation, audits revisions and limits targeting', async () => {
    await expect(
      service.snippet(null, { name: 'unconfirmed', placement: 'after_content', content: 'hello' }),
    ).rejects.toMatchObject({ code: 'confirmation' });
    await service.snippet(null, {
      name: 'banner',
      placement: 'after_content',
      content: '<p>Global announcement</p>',
      enabled: true,
      targeting: { kinds: ['posts'] },
      confirmation: 'APPLY GLOBAL CODE',
    });
    expect(await (await publicGet('a.localhost', '/final-article')).text()).toContain(
      'Global announcement',
    );
    expect(await (await publicGet('b.localhost')).text()).not.toContain('Global announcement');
    const row = await env.DB.prepare(
      "SELECT * FROM audit_logs WHERE action='snippet.save'",
    ).first();
    expect(row).toBeTruthy();
  });
  it('uploads real image bytes to R2 and prevents cross-tenant reads', async () => {
    const png = Uint8Array.from(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=',
        'base64',
      ),
    );
    const media = await upload(
      service,
      a.id,
      new File([png], 'pixel.png', { type: 'image/png' }),
      'A pixel',
    );
    expect(media.width).toBe(1);
    expect((await publicGet('a.localhost', media.url)).status).toBe(200);
    expect((await publicGet('b.localhost', media.url)).status).toBe(404);
    const response = await publicGet('a.localhost', media.url);
    expect(response.headers.get('content-type')).toBe('image/png');
  });
  it('previews unsaved edits without publishing, revising or changing tenant cache', async () => {
    const draft = await service.createPost(a.id, {
      title: 'Preview original',
      slug: 'preview-original',
      markdown_content: 'Original content',
    });
    const live = await service.publish(a.id, draft.id, { version: draft.version });
    const beforePost = await service.getPost(a.id, draft.id);
    const beforeSite = await service.getSite(a.id);
    const response = await request(`/api/v1/sites/${a.id}/preview`, 'POST', {
      post_id: live.id,
      post: {
        title: 'Unsaved preview title',
        slug: 'unsaved-preview',
        markdown_content: '## Unsaved heading\n\n<script>window.hacked=true</script>',
      },
      seo: { seo_title: 'Preview SEO title' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-robots-tag')).toBe('noindex');
    expect(response.headers.get('cache-control')).toBe('no-store');
    const html = await response.text();
    expect(html).toContain('Unsaved preview title');
    expect(html).toContain('Unsaved heading');
    expect(html).toContain('<title>Preview SEO title</title>');
    expect(html).not.toContain('<script>window.hacked');
    expect(await service.getPost(a.id, draft.id)).toEqual(beforePost);
    expect(await service.getSite(a.id)).toEqual(beforeSite);
    const crossTenant = await request(`/api/v1/sites/${b.id}/preview`, 'POST', {
      post_id: live.id,
      post: { title: 'Wrong site', slug: 'wrong' },
    });
    expect(crossTenant.status).toBe(404);
  });
  it('enforces role membership and author ownership', async () => {
    const user = await service.createUser({
      email: 'author@example.com',
      display_name: 'Author',
      password: 'long-enough-password',
    });
    await service.membership(a.id, { user_id: user.id, role: 'author' });
    const author = new Service(
      env,
      { id: user.id, type: 'user', superAdmin: false, scopes: [] },
      id(),
    );
    await expect(author.getPost(a.id, post.id)).rejects.toMatchObject({ code: 'author_denied' });
    const draft = await author.createPost(a.id, { title: 'Author draft', slug: 'author-draft' });
    await expect(author.publish(a.id, draft.id)).rejects.toMatchObject({ code: 'tenant_denied' });
    await expect(author.listPosts(b.id)).rejects.toMatchObject({ code: 'tenant_denied' });
  });
  it('authenticates HttpOnly sessions and rejects cross-origin session mutations', async () => {
    const login = await request(
      '/api/v1/auth/login',
      'POST',
      { email: 'author@example.com', password: 'long-enough-password' },
      '',
      { origin: 'http://localhost' },
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    const identity = await request('/api/v1/auth/me', 'GET', undefined, '', {
      cookie: cookie.split(';')[0],
    });
    const identityBody = (await identity.json()) as any;
    expect(identityBody.data.display_name).toBe('Author');
    expect(identityBody.data.memberships).toHaveLength(1);
    expect(identityBody.data.memberships[0]).toMatchObject({ site_id: a.id, role: 'author' });
    expect(identityBody.data.memberships[0].scopes).toContain('content:write');
    expect(identityBody.data.memberships[0].scopes).not.toContain('content:publish');
    const forbiddenPreview = await request(
      `/api/v1/sites/${b.id}/preview`,
      'POST',
      { post: { title: 'Other tenant', slug: 'other' } },
      '',
      { cookie: cookie.split(';')[0], origin: 'http://localhost' },
    );
    expect(forbiddenPreview.status).toBe(403);
    const forbiddenPost = await request(
      `/api/v1/sites/${a.id}/preview`,
      'POST',
      { post_id: post.id, post: { title: 'Other author', slug: 'other' } },
      '',
      { cookie: cookie.split(';')[0], origin: 'http://localhost' },
    );
    expect(forbiddenPost.status).toBe(403);

    const result = await request(
      `/api/v1/sites/${a.id}/posts`,
      'POST',
      { title: 'CSRF', slug: 'csrf' },
      '',
      { cookie: cookie.split(';')[0], origin: 'https://evil.example' },
    );
    expect(result.status).toBe(403);
  });
  it('replays idempotent creates without duplicating rows and rejects changed input', async () => {
    const key = id();
    const data = { title: 'Idempotent', slug: 'idempotent' };
    const a1 = await request(`/api/v1/sites/${a.id}/posts`, 'POST', data, token, {
      'idempotency-key': key,
    });
    const a2 = await request(`/api/v1/sites/${a.id}/posts`, 'POST', data, token, {
      'idempotency-key': key,
    });
    expect(a1.status).toBe(201);
    expect(await a1.json()).toEqual(await a2.json());
    expect(
      (
        await request(
          `/api/v1/sites/${a.id}/posts`,
          'POST',
          { ...data, title: 'Different' },
          token,
          { 'idempotency-key': key },
        )
      ).status,
    ).toBe(409);
  });
  it('runs MCP create/publish through the same service and audits mcp actor', async () => {
    const init = await request('/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    expect(((await init.json()) as any).result.protocolVersion).toBe('2025-11-25');
    const created = await request('/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'create_post',
        arguments: { site_id: a.id, input: { title: 'MCP article', slug: 'mcp-article' } },
      },
    });
    const data = JSON.parse(((await created.json()) as any).result.content[0].text);
    const published = await request('/mcp', 'POST', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'publish_post', arguments: { site_id: a.id, post_id: data.id } },
    });
    expect(((await published.json()) as any).result.isError).toBe(false);
    expect((await publicGet('a.localhost', '/mcp-article')).status).toBe(200);
    expect(
      await env.DB.prepare("SELECT id FROM audit_logs WHERE actor_type='mcp' AND resource=?")
        .bind(data.id)
        .first(),
    ).toBeTruthy();
  });
  it('compares weighted metrics with volume thresholds and site authorization', async () => {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO analytics_daily_site(site_id,date,clicks,impressions,position) VALUES (?,?,?,?,?)',
      ).bind(a.id, '2026-09-01', 100, 1000, 4),
      env.DB.prepare(
        'INSERT INTO analytics_daily_site(site_id,date,clicks,impressions,position) VALUES (?,?,?,?,?)',
      ).bind(a.id, '2026-09-02', 150, 1500, 3),
      env.DB.prepare(
        'INSERT INTO analytics_daily_site(site_id,date,clicks,impressions,position) VALUES (?,?,?,?,?)',
      ).bind(b.id, '2026-09-01', 2, 20, 10),
      env.DB.prepare(
        'INSERT INTO analytics_daily_site(site_id,date,clicks,impressions,position) VALUES (?,?,?,?,?)',
      ).bind(b.id, '2026-09-02', 8, 80, 8),
    ]);
    const data = await performance(env, admin, '2026-09-02', '2026-09-02');
    expect(data.winners).toHaveLength(1);
    expect(data.winners[0].click_delta).toEqual({ absolute: 50, percent: 50 });
    const scoped: Actor = {
      id: 'b',
      type: 'api',
      superAdmin: false,
      siteId: b.id,
      scopes: ['analytics:read'],
    };
    expect(
      (await performance(env, scoped, '2026-09-02', '2026-09-02')).sites.every(
        (x) => x.site_id === b.id,
      ),
    ).toBe(true);
    await expect(performance(env, scoped, '2026-09-02', '2026-09-02', a.id)).rejects.toMatchObject({
      code: 'tenant_denied',
    });
  });
  it('exports tenant-only data and audits SEO job completion', async () => {
    const exported = await exportTenant(env, a.id);
    expect(exported.format).toBe('penlum-tenant-v1');
    expect((exported.posts as Post[]).every((p) => p.site_id === a.id)).toBe(true);
    expect(exported).not.toHaveProperty('api_credentials');
    const job = await service.enqueue('audit', a.id);
    await executeJob(env, job);
    expect(
      await env.DB.prepare("SELECT id FROM jobs WHERE id=? AND status='completed'")
        .bind(job.id)
        .first(),
    ).toBeTruthy();
    expect((await runAudit(env, a.id)).some((i) => i.rule === 'orphan_page')).toBe(true);
  });
  it('restores a tenant export into a clean D1 with safe staging defaults', async () => {
    const exported = await exportTenant(env, a.id);
    const restore = restoreSQL(exported);
    const fresh = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      compatibilityDate: '2026-07-01',
      d1Databases: ['DB'],
    });
    try {
      const db = await fresh.getD1Database('DB');
      await db.batch(
        readFileSync('migrations/0001_core.sql', 'utf8')
          .split(';')
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => db.prepare(s)),
      );
      await db.batch(restore.map((s) => db.prepare(s)));
      const restored = await db.prepare('SELECT * FROM sites WHERE id=?').bind(a.id).first();
      expect(restored?.status).toBe('staging');
      expect(restored?.robots_mode).toBe('noindex');
      expect(
        (await db.prepare('SELECT count(*) n FROM posts WHERE site_id=?').bind(a.id).first())?.n,
      ).toBe((exported.posts as Post[]).length);
      expect(
        (await db.prepare('SELECT * FROM site_domains WHERE site_id=?').bind(a.id).first())?.status,
      ).toBe('pending');
      await expect(db.batch(restore.map((s) => db.prepare(s)))).rejects.toThrow();
    } finally {
      await fresh.dispose();
    }
  });
  it('syncs GSC page aggregates idempotently and keeps prior data on failure', async () => {
    await env.DB.prepare('INSERT INTO analytics_sync_state(site_id,property) VALUES (?,?)')
      .bind(a.id, 'sc-domain:a.localhost')
      .run();
    const configured = {
      ...env,
      GSC_CLIENT_ID: 'fixture-client',
      GSC_CLIENT_SECRET: 'fixture-secret',
      GSC_REFRESH_TOKEN: 'fixture-refresh',
    };
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).includes('oauth2')) return Response.json({ access_token: 'fixture-token' });
      const query = JSON.parse(String(init?.body));
      return Response.json(
        query.dimensions.length
          ? {
              rows: [
                {
                  keys: ['https://a.localhost/final-article'],
                  clicks: 20,
                  impressions: 200,
                  position: 3,
                },
                {
                  keys: ['https://b.localhost/foreign'],
                  clicks: 90,
                  impressions: 900,
                  position: 1,
                },
              ],
            }
          : { rows: [{ clicks: 20, impressions: 200, position: 3 }] },
      );
    });
    try {
      await syncGSC(configured, a.id, '2026-08-20');
      await syncGSC(configured, a.id, '2026-08-20');
      const pages = (
        await env.DB.prepare('SELECT * FROM analytics_daily_page WHERE site_id=? AND date=?')
          .bind(a.id, '2026-08-20')
          .all()
      ).results;
      expect(pages).toHaveLength(1);
      expect(pages[0].path).toBe('/final-article');
      fetchMock.mockImplementation(async () => new Response('failure', { status: 503 }));
      await expect(syncGSC(configured, a.id, '2026-08-20')).rejects.toMatchObject({
        code: 'gsc_auth',
      });
      expect(
        (
          await env.DB.prepare('SELECT clicks FROM analytics_daily_page WHERE site_id=? AND date=?')
            .bind(a.id, '2026-08-20')
            .first()
        )?.clicks,
      ).toBe(20);
    } finally {
      fetchMock.mockRestore();
    }
  });
  it('publishes due scheduled posts through the same audited service', async () => {
    const draft = await service.createPost(a.id, { title: 'Scheduled', slug: 'scheduled' });
    await service.publish(a.id, draft.id, {
      scheduled_at: new Date(Date.now() + 600000).toISOString(),
    });
    await env.DB.prepare('UPDATE posts SET scheduled_at=? WHERE site_id=? AND id=?')
      .bind('2000-01-01T00:00:00.000Z', a.id, draft.id)
      .run();
    await scheduled(env, '*/5 * * * *');
    expect((await service.getPost(a.id, draft.id)).status).toBe('published');
    expect(
      await env.DB.prepare(
        "SELECT id FROM audit_logs WHERE resource=? AND actor_type='system' AND action='post.published'",
      )
        .bind(draft.id)
        .first(),
    ).toBeTruthy();
  });
  it('rejects untrusted MCP origins and keeps global search within a site credential', async () => {
    expect(
      (
        await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'ping' }, token, {
          origin: 'https://evil.example',
        })
      ).status,
    ).toBe(403);
    const key = await service.credential({
      name: 'search-b',
      type: 'site',
      site_id: b.id,
      scopes: ['content:read'],
    });
    const result = await request('/api/v1/content', 'GET', undefined, key.token);
    expect(result.status).toBe(200);
    expect(((await result.json()) as any).data.every((p: Post) => p.site_id === b.id)).toBe(true);
  });
  it('archives without deleting and fails closed on pending domains', async () => {
    await service.siteStatus(b.id, 'archived');
    expect((await publicGet('b.localhost')).status).toBe(404);
    expect(await service.getSite(b.id)).toBeTruthy();
    const pending = await service.createSite({
      name: 'Pending',
      primary_domain: 'pending.example',
      site_title: 'Pending',
    });
    await expect(service.siteStatus(pending.id!, 'active')).rejects.toMatchObject({
      code: 'domain_unverified',
    });
  });
});
