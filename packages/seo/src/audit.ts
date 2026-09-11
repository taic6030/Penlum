import { Database, type Post } from '../../db/src/index';
import { id, now, type Env } from '../../shared/src/index';
import { renderMarkdown, internalLinks } from '../../content/src/index';
import { isIndexable, canonical, type SEO } from './index';
export async function runAudit(env: Env, siteId: string) {
  const database = new Database(env.DB);
  const site = (await database.site(siteId))!;
  const repo = database.forSite(siteId);
  const posts = (
    await repo
      .statement(
        "SELECT p.*,s.seo_title,s.description,s.canonical_override,s.noindex,s.schema_overrides_json FROM posts p LEFT JOIN seo_meta s ON s.site_id=p.site_id AND s.entity_id=p.id AND s.entity_type='post' WHERE p.site_id=? AND p.deleted_at IS NULL LIMIT 2000",
      )
      .all<Post & SEO>()
  ).results;
  const issues: {
    entity_id: string | null;
    path: string;
    rule: string;
    severity: string;
    details: string;
  }[] = [];
  const add = (post: Post | null, rule: string, details: string, severity = 'warning') =>
    issues.push({
      entity_id: post?.id || null,
      path: post ? '/' + post.slug : '/',
      rule,
      severity,
      details,
    });
  const published = posts.filter((p) => p.status === 'published');
  const paths = new Set(published.map((p) => '/' + p.slug));
  paths.add('/');
  const redirects = await repo.all<{ source_path: string; target: string; enabled: number }>(
    'redirects',
    10000,
  );
  const map = new Map(redirects.filter((r) => r.enabled).map((r) => [r.source_path, r.target]));
  const categories = await repo.all<{ slug: string }>('categories', 2000);
  categories.forEach((c) => paths.add('/category/' + c.slug));
  const incoming = new Map<string, number>();
  const titles = new Map<string, string>();
  for (const post of published) {
    const title = post.seo_title || post.title;
    if (!title.trim()) add(post, 'missing_title', 'Page title is empty', 'error');
    if (titles.has(title)) add(post, 'duplicate_title', `Same title as ${titles.get(title)}`);
    titles.set(title, '/' + post.slug);
    if (!(post.description || post.excerpt))
      add(post, 'missing_description', 'No SEO description or excerpt');
    if (
      post.canonical_override &&
      canonical(site, '/' + post.slug, post) !== `https://${site.primary_domain}/${post.slug}`
    )
      add(post, 'canonical_anomaly', 'Canonical points to another URL; excluded from sitemap');
    if ((post.markdown_content.match(/^#\s/gm) || []).length)
      add(post, 'h1_anomaly', 'The template supplies H1; use H2–H6 in Markdown');
    const rendered = renderMarkdown(post.markdown_content);
    for (const image of rendered.html.matchAll(/<img\b[^>]*>/g))
      if (!/alt="[^"\s][^"]*"/.test(image[0]))
        add(post, 'missing_alt', 'Image is missing descriptive alt text');
    for (const path of internalLinks(post.markdown_content, site.primary_domain)) {
      if (path !== '/' + post.slug) incoming.set(path, (incoming.get(path) || 0) + 1);
      if (!paths.has(path) && !map.has(path) && !path.startsWith('/media/'))
        add(post, 'internal_404', `Internal link is not published: ${path}`, 'error');
    }
    try {
      JSON.parse(post.schema_overrides_json || '{}');
    } catch {
      add(post, 'invalid_structured_data', 'Schema overrides are invalid JSON', 'error');
    }
    if (isIndexable(site, post, post) && post.noindex)
      add(post, 'noindex_in_sitemap', 'Noindex URL would enter sitemap', 'error');
  }
  for (const post of published)
    if (!incoming.get('/' + post.slug))
      add(post, 'orphan_page', 'No contextual inbound links from other published pages');
  for (const [source, target] of map) {
    if (map.has(target))
      issues.push({
        entity_id: null,
        path: source,
        rule: target === source ? 'redirect_loop' : 'redirect_chain',
        severity: 'error',
        details: `${source} → ${target}`,
      });
  }
  const media = await repo.all<{ id: string; bytes: number; filename: string }>('media', 2000);
  for (const m of media)
    if (m.bytes > 500000)
      issues.push({
        entity_id: m.id,
        path: '/media/' + m.id,
        rule: 'oversized_image',
        severity: 'warning',
        details: `${m.filename}: ${m.bytes} bytes`,
      });
  const statements = [
    env.DB.prepare(
      "UPDATE seo_audit_results SET status='resolved',resolved_at=? WHERE site_id=? AND status='open'",
    ).bind(now(), siteId),
    ...issues.map((i) =>
      env.DB.prepare(
        'INSERT INTO seo_audit_results(id,site_id,entity_id,path,rule,severity,details,detected_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(id(), siteId, i.entity_id, i.path, i.rule, i.severity, i.details, now()),
    ),
  ];
  await env.DB.batch(statements);
  return issues;
}
