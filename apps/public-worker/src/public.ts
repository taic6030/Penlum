import { Database, type Post } from '../../../packages/db/src/index';
import { render } from '../../../packages/renderer/src/index';
import { sitemap, type SEO } from '../../../packages/seo/src/index';
import { normalizeHost, now, type Env } from '../../../packages/shared/src/index';
import type { Snippet, PageKind } from '../../../packages/themes/src/index';
export async function publicRequest(
  request: Request,
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
) {
  if (!['GET', 'HEAD'].includes(request.method))
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  const url = new URL(request.url);
  const host = normalizeHost(url.host);
  const database = new Database(env.DB);
  const site = await database.resolve(host);
  const missing = () =>
    new Response('Website not found', {
      status: 404,
      headers: { 'x-robots-tag': 'noindex', 'cache-control': 'no-store' },
    });
  if (!site || site.status !== 'active') return missing();
  if (env.ENVIRONMENT === 'production' && url.protocol !== 'https:')
    return Response.redirect(`https://${host}${url.pathname}${url.search}`, 301);
  if (site.hostname !== site.primary_domain && site.redirect_to_primary)
    return Response.redirect(`https://${site.primary_domain}${url.pathname}${url.search}`, 301);
  let path: string;
  try {
    path = decodeURI(url.pathname);
  } catch {
    return new Response('Invalid path', { status: 400 });
  }
  if (path !== '/' && path.endsWith('/'))
    return Response.redirect(`${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`, 301);
  const repo = database.forSite(site.id);
  if (path.startsWith('/media/')) {
    const media = await repo
      .statement('SELECT * FROM media WHERE site_id=? AND id=?', path.slice(7))
      .first<{ r2_key: string; mime: string }>();
    if (!media) return missing();
    const object = await env.MEDIA.get(media.r2_key);
    if (!object) return missing();
    return new Response(request.method === 'HEAD' ? null : object.body, {
      headers: {
        'content-type': media.mime,
        etag: object.httpEtag,
        'cache-control': 'public,max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  }
  const globalVersion = await env.DB.prepare(
    "SELECT value FROM system_state WHERE key='global_cache_version'",
  ).first<{ value: string }>();
  // Read current generation from D1 on every request. A site mutation never
  // invalidates another site; global code intentionally increments global generation.
  const key = new Request(
    `https://${host}/__penlum_cache/${site.id}/${site.cache_version}/${globalVersion?.value || 1}${url.pathname}`,
  );
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = await cache.match(key);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('x-penlum-cache', 'HIT');
    return new Response(request.method === 'HEAD' ? null : cached.body, {
      status: cached.status,
      headers,
    });
  }
  const redirect = await repo
    .statement(
      'SELECT target,status_code FROM redirects WHERE site_id=? AND source_path=? AND enabled=1',
      path,
    )
    .first<{ target: string; status_code: 301 | 302 }>();
  if (redirect)
    return Response.redirect(
      new URL(redirect.target, `https://${site.primary_domain}`).href,
      redirect.status_code,
    );
  const siteSEO =
    (await repo
      .statement(
        "SELECT * FROM seo_meta WHERE site_id=? AND entity_type='site' AND entity_id=?",
        site.id,
      )
      .first<SEO>()) || {};
  let response: Response;
  if (path === '/robots.txt')
    response = new Response(
      `User-agent: *\n${site.robots_mode === 'index' ? 'Allow: /' : 'Disallow: /'}\nSitemap: https://${site.primary_domain}/sitemap.xml\n`,
      { headers: { 'content-type': 'text/plain; charset=utf-8' } },
    );
  else if (path === '/sitemap.xml') {
    const posts = (
      await repo
        .statement(
          "SELECT p.*,s.noindex,s.canonical_override FROM posts p LEFT JOIN seo_meta s ON s.site_id=p.site_id AND s.entity_id=p.id AND s.entity_type='post' WHERE p.site_id=? AND p.status='published' AND p.deleted_at IS NULL AND p.published_at<=?",
          now(),
        )
        .all<Post & SEO>()
    ).results;
    response = new Response(sitemap(site, posts, siteSEO), {
      headers: { 'content-type': 'application/xml; charset=utf-8' },
    });
  } else {
    let kind: PageKind = '404',
      post: Post | undefined,
      posts: Post[] = [],
      seo: SEO = siteSEO,
      title: string | undefined;
    if (path === '/') {
      kind = 'home';
      posts = (
        await repo
          .statement(
            "SELECT * FROM posts WHERE site_id=? AND status='published' AND deleted_at IS NULL AND published_at<=? ORDER BY published_at DESC LIMIT 100",
            now(),
          )
          .all<Post>()
      ).results;
    } else if (path.startsWith('/category/')) {
      const category = await repo
        .statement('SELECT * FROM categories WHERE site_id=? AND slug=?', path.slice(10))
        .first<{ id: string; name: string }>();
      if (category) {
        kind = 'categories';
        title = category.name;
        seo = {};
        posts = (
          await repo
            .statement(
              "SELECT p.* FROM posts p JOIN post_categories pc ON pc.site_id=p.site_id AND pc.post_id=p.id WHERE p.site_id=? AND pc.category_id=? AND p.status='published' AND p.deleted_at IS NULL AND p.published_at<=? ORDER BY p.published_at DESC LIMIT 100",
              category.id,
              now(),
            )
            .all<Post>()
        ).results;
      }
    } else if (/^\/[^/]+$/.test(path)) {
      post = (await repo.postBySlug(path.slice(1))) || undefined;
      if (post) {
        kind = post.type === 'post' ? 'posts' : 'pages';
        seo =
          (await repo
            .statement(
              "SELECT * FROM seo_meta WHERE site_id=? AND entity_type='post' AND entity_id=?",
              post.id,
            )
            .first<SEO>()) || {};
      }
    }
    const snippets = (
      await env.DB.prepare(
        'SELECT * FROM code_snippets WHERE (site_id=? OR site_id IS NULL) AND enabled=1 ORDER BY priority,id',
      )
        .bind(site.id)
        .all<Snippet>()
    ).results;
    const navigation = (
      await repo
        .statement(
          "SELECT i.label,i.url FROM navigation_items i JOIN navigation_menus m ON m.site_id=i.site_id AND m.id=i.menu_id WHERE i.site_id=? AND m.name='main' ORDER BY i.position",
        )
        .all<{ label: string; url: string }>()
    ).results;
    const featured = post?.featured_media
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
    const media = post
      ? await repo.all<{ id: string; width: number; height: number }>('media', 2000)
      : [];
    const result = await render({
      media,
      site,
      path,
      kind,
      post,
      posts,
      seo,
      title,
      snippets,
      navigation,
      featured: featured || undefined,
      settings: JSON.parse(settings?.settings || '{}'),
    });
    response = new Response(result.html, {
      status: kind === '404' ? 404 : 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': result.csp,
        ...(kind === '404' || site.robots_mode !== 'index' ? { 'x-robots-tag': 'noindex' } : {}),
      },
    });
  }
  response.headers.set('x-content-type-options', 'nosniff');
  response.headers.set('referrer-policy', 'strict-origin-when-cross-origin');
  response.headers.set('cache-control', 'public, max-age=0, s-maxage=300');
  const toCache = response.clone();
  toCache.headers.set('cache-control', 'public,max-age=300');
  ctx.waitUntil(cache.put(key, toCache));
  response.headers.set('x-penlum-cache', 'MISS');
  return new Response(request.method === 'HEAD' ? null : response.body, {
    status: response.status,
    headers: response.headers,
  });
}
