import type { Site, Post } from '../../db/src/index';
import { escape, jsonScript } from '../../shared/src/index';
export interface SEO {
  seo_title?: string | null;
  description?: string | null;
  canonical_override?: string | null;
  noindex?: number;
  nofollow?: number;
  og_title?: string | null;
  og_description?: string | null;
  og_image?: string | null;
  schema_type?: string;
  schema_overrides_json?: string;
}
export function canonical(site: Site, path: string, seo: SEO = {}) {
  return seo.canonical_override || `https://${site.primary_domain}${path}`;
}
export function isIndexable(site: Site, post?: Post, seo: SEO = {}) {
  return (
    site.status === 'active' &&
    site.robots_mode === 'index' &&
    !seo.noindex &&
    (!post ||
      (post.status === 'published' &&
        !post.deleted_at &&
        !!post.published_at &&
        post.published_at <= new Date().toISOString()))
  );
}
export function seoHead(
  site: Site,
  path: string,
  post?: Post,
  seo: SEO = {},
  titleOverride?: string,
  noindex = false,
) {
  const title = seo.seo_title || titleOverride || post?.title || site.site_title;
  const description = seo.description || post?.excerpt || site.description;
  const url = canonical(site, path, seo);
  const index = !noindex && isIndexable(site, post, seo);
  const og = seo.og_image || site.default_og;
  const absoluteOG = og ? new URL(og, `https://${site.primary_domain}`).href : null;
  const schema: Record<string, unknown>[] = [
    {
      '@context': 'https://schema.org',
      '@type': 'WebSite',
      '@id': `https://${site.primary_domain}/#website`,
      url: `https://${site.primary_domain}/`,
      name: site.site_title,
      inLanguage: site.locale,
    },
    {
      '@context': 'https://schema.org',
      '@type': 'WebPage',
      url,
      name: title,
      description,
      inLanguage: site.locale,
      isPartOf: { '@id': `https://${site.primary_domain}/#website` },
    },
  ];
  if (post && post.type === 'post')
    schema.push({
      '@context': 'https://schema.org',
      '@type': seo.schema_type === 'Article' ? 'Article' : 'BlogPosting',
      headline: post.title,
      description,
      url,
      datePublished: post.published_at,
      dateModified: post.updated_at,
      ...(absoluteOG ? { image: absoluteOG } : {}),
      ...JSON.parse(seo.schema_overrides_json || '{}'),
    });
  if (path !== '/')
    schema.push({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        {
          '@type': 'ListItem',
          position: 1,
          name: site.site_title,
          item: `https://${site.primary_domain}/`,
        },
        { '@type': 'ListItem', position: 2, name: title, item: url },
      ],
    });
  return `<title>${escape(title)}</title><meta name="description" content="${escape(description)}"><meta name="robots" content="${index ? 'index' : 'noindex'},${seo.nofollow ? 'nofollow' : 'follow'}"><link rel="canonical" href="${escape(url)}"><meta property="og:type" content="${post?.type === 'post' ? 'article' : 'website'}"><meta property="og:title" content="${escape(seo.og_title || title)}"><meta property="og:description" content="${escape(seo.og_description || description)}"><meta property="og:url" content="${escape(url)}"><meta property="og:site_name" content="${escape(site.site_title)}">${absoluteOG ? `<meta property="og:image" content="${escape(absoluteOG)}">` : ''}<script type="application/ld+json">${jsonScript(schema)}</script>`;
}
export function sitemap(site: Site, posts: (Post & SEO)[], siteSEO: SEO = {}) {
  const urls: { path: string; updated: string }[] = [];
  if (
    isIndexable(site, undefined, siteSEO) &&
    canonical(site, '/', siteSEO) === `https://${site.primary_domain}/`
  )
    urls.push({ path: '/', updated: site.updated_at });
  for (const post of posts) {
    const path = '/' + post.slug;
    if (
      isIndexable(site, post, post) &&
      canonical(site, path, post) === `https://${site.primary_domain}${path}`
    )
      urls.push({ path, updated: post.updated_at });
  }
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${escape(`https://${site.primary_domain}${u.path}`)}</loc><lastmod>${escape(u.updated)}</lastmod></url>`).join('')}</urlset>`;
}
