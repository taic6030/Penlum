import type { Post, Site } from '../../db/src/index';
import { renderMarkdown, sanitize } from '../../content/src/index';
import { seoHead, type SEO } from '../../seo/src/index';
import { escape } from '../../shared/src/index';
import { themes, matchesTarget, type Snippet, type PageKind } from '../../themes/src/index';
export interface RenderData {
  site: Site;
  path: string;
  kind: PageKind;
  post?: Post;
  posts?: Post[];
  seo?: SEO;
  title?: string;
  snippets: Snippet[];
  navigation: { label: string; url: string }[];
  featured?: { id: string; alt: string; width: number; height: number };
  noindex?: boolean;
  media?: { id: string; width: number; height: number }[];
  settings?: {
    container?: 'narrow' | 'wide';
    typography?: 'serif' | 'sans';
    spacing?: 'compact' | 'comfortable';
  };
}
export async function render(data: RenderData) {
  const { site, post, path, kind } = data;
  const theme = themes[site.theme_id as keyof typeof themes] || themes.journal;
  const selected = data.snippets
    .filter((s) => s.enabled && matchesTarget(JSON.parse(s.targeting), kind, path))
    .sort((a, b) => a.priority - b.priority);
  const slots = (name: string) =>
    selected
      .filter((s) => s.placement === name)
      .map((s) => (s.executable ? s.content : sanitize(s.content)))
      .join('');
  const cards = (data.posts || [])
    .map(
      (p) =>
        `<article class="card"><small>${p.type === 'page' ? 'Trang' : 'Bài viết'}${p.published_at ? ' · ' + escape(p.published_at.slice(0, 10)) : ''}</small><h2><a href="/${escape(p.slug)}">${escape(p.title)}</a></h2><p>${escape(p.excerpt)}</p></article>`,
    )
    .join('');
  const media = new Map((data.media || []).map((image) => [image.id, image]));
  const prose = post
    ? renderMarkdown(post.markdown_content).html.replace(
        /<img\b[^>]*src="\/media\/([^"/]+)"[^>]*>/g,
        (tag, mediaId) => {
          const image = media.get(mediaId);
          return image
            ? tag
                .replace(/width="[^"]*"/, `width="${image.width}"`)
                .replace(/height="[^"]*"/, `height="${image.height}"`)
            : tag;
        },
      )
    : '';
  const body = post
    ? `<article><header class="article-header"><p class="eyebrow">${escape(site.name)}</p><h1>${escape(post.title)}</h1>${post.excerpt ? `<p class="lead">${escape(post.excerpt)}</p>` : ''}${post.published_at ? `<time datetime="${escape(post.published_at)}">${escape(new Intl.DateTimeFormat(site.locale, { dateStyle: 'long', timeZone: site.timezone }).format(new Date(post.published_at)))}</time>` : ''}</header>${data.featured ? `<img class="featured" src="/media/${escape(data.featured.id)}" alt="${escape(data.featured.alt)}" width="${data.featured.width}" height="${data.featured.height}" fetchpriority="high" decoding="async">` : ''}${slots('before_content')}<div class="prose">${prose}</div>${slots('after_content')}</article>`
    : kind === '404'
      ? '<h1>Không tìm thấy trang</h1><p>Trang này không tồn tại hoặc chưa được xuất bản.</p><a href="/">Về trang chủ</a>'
      : `<header class="article-header"><p class="eyebrow">${escape(site.name)}</p><h1>${escape(data.title || site.site_title)}</h1><p class="lead">${escape(site.description)}</p></header>${slots('before_content')}<section aria-label="Bài viết">${cards || '<p>Nội dung đang được chuẩn bị.</p>'}</section>${slots('after_content')}`;
  const font =
    data.settings?.typography === 'sans'
      ? 'system-ui,sans-serif'
      : data.settings?.typography === 'serif'
        ? 'Georgia,serif'
        : theme.font;
  const width =
    data.settings?.container === 'wide'
      ? '960px'
      : data.settings?.container === 'narrow'
        ? '680px'
        : theme.width;
  const html = `<!doctype html><html lang="${escape(site.locale)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${seoHead(site, path, post, data.seo, data.title, data.noindex || kind === '404')}${site.favicon ? `<link rel="icon" href="${escape(site.favicon)}">` : ''}<style>:root{color-scheme:light;--accent:${theme.accent}}*{box-sizing:border-box}body{margin:0;background:${theme.background};color:#20282b;font:18px/1.8 ${font}}a{color:var(--accent);text-underline-offset:4px}a:hover{text-decoration-thickness:2px}.shell{max-width:${width};margin:auto;padding:0 24px}nav{display:flex;align-items:center;gap:24px;padding:24px 0;border-bottom:1px solid #dce2e0;font:15px system-ui;flex-wrap:wrap}.brand{font-weight:750;font-size:22px;margin-right:auto;text-decoration:none}.brand img{max-height:48px;width:auto}main{padding:48px 0 64px;min-height:65vh}h1,h2,h3{line-height:1.2;letter-spacing:-.025em;overflow-wrap:anywhere}h1{font-size:clamp(2rem,6vw,3.25rem);margin:12px 0 24px}h2{font-size:1.8rem}.lead{font-size:1.25rem;color:#53605e}.eyebrow,small,time{font:14px/1.6 system-ui;color:#53605e}.eyebrow{text-transform:uppercase;letter-spacing:.12em}.article-header{margin-bottom:40px}.card{padding:28px 0;border-top:1px solid #dce2e0}.card h2{margin:8px 0}.card h2 a{text-decoration:none}.card p{margin:0}.prose{overflow-wrap:anywhere}.prose p,.prose ul,.prose ol{margin:1.3em 0}.prose h2,.prose h3{margin-top:2em;scroll-margin-top:24px}img{max-width:100%;height:auto}.featured{width:100%;margin-bottom:32px}pre{overflow:auto;background:#152b30;color:#e5eded;padding:20px;border-radius:8px;font-size:15px}table{display:block;overflow-x:auto;border-collapse:collapse}th,td{padding:10px;border:1px solid #ccd5d2}blockquote{margin-left:0;padding-left:24px;border-left:3px solid var(--accent)}footer{padding:32px 0;border-top:1px solid #dce2e0;font:14px system-ui}.skip{position:absolute;left:-9999px}.skip:focus{left:16px;top:16px;background:white;padding:12px}:focus-visible{outline:3px solid var(--accent);outline-offset:4px}@media(max-width:600px){main{padding-top:24px}nav{gap:16px}.shell{padding:0 20px}}</style>${slots('head')}</head><body><a class="skip" href="#main">Bỏ qua điều hướng</a>${slots('body_start')}<div class="shell"><nav aria-label="Điều hướng chính"><a class="brand" href="/">${site.logo ? `<img src="${escape(site.logo)}" width="160" height="48" alt="${escape(site.name)}">` : escape(site.name)}</a>${data.navigation.map((n) => `<a href="${escape(n.url)}">${escape(n.label)}</a>`).join('')}</nav>${slots('header_banner')}<main id="main">${body}${slots('sidebar')}</main>${slots('footer_banner')}<footer>© ${new Date().getFullYear()} ${escape(site.name)}</footer></div>${slots('body_end')}</body></html>`;
  const hashes = [];
  for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(match[1]));
    hashes.push(`'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`);
  }
  return {
    html,
    csp: `default-src 'none'; script-src ${hashes.join(' ') || "'none'"}; style-src 'unsafe-inline'; img-src 'self' https:; font-src 'self'; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
  };
}
