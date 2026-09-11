import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';
export const sanitize = (html: string) =>
  sanitizeHtml(html, {
    allowedTags: [
      'p',
      'br',
      'hr',
      'h2',
      'h3',
      'h4',
      'h5',
      'h6',
      'blockquote',
      'ul',
      'ol',
      'li',
      'strong',
      'em',
      'del',
      'a',
      'img',
      'pre',
      'code',
      'table',
      'thead',
      'tbody',
      'tr',
      'th',
      'td',
      'figure',
      'figcaption',
      'div',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height', 'loading', 'decoding'],
      code: ['class'],
      '*': ['id'],
    },
    allowedSchemes: ['https', 'http', 'mailto'],
    allowProtocolRelative: false,
    transformTags: {
      a: (_tag, attrs) => ({ tagName: 'a', attribs: { ...attrs, rel: 'noopener noreferrer' } }),
      img: (_tag, attrs) => ({
        tagName: 'img',
        attribs: {
          ...attrs,
          width: attrs.width || '1200',
          height: attrs.height || '800',
          loading: 'lazy',
          decoding: 'async',
        },
      }),
    },
  });
export function renderMarkdown(markdown: string) {
  // User HTML is escaped before parsing. Only generated Markdown elements enter
  // the sanitizer; executable HTML is exclusively handled by privileged snippets.
  let html = sanitize(
    marked.parse(markdown.replace(/</g, '&lt;'), { async: false, gfm: true }) as string,
  );
  const counts = new Map<string, number>();
  const headings: { level: number; id: string; text: string }[] = [];
  html = html.replace(/<h([2-6])>([\s\S]*?)<\/h\1>/g, (_all, level, body) => {
    const text = body.replace(/<[^>]+>/g, '');
    const base =
      text
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'section';
    const count = counts.get(base) || 0;
    counts.set(base, count + 1);
    const id = count ? `${base}-${count}` : base;
    headings.push({ level: Number(level), id, text });
    return `<h${level} id="${id}">${body}</h${level}>`;
  });
  return { html, headings };
}
export function internalLinks(markdown: string, domain: string) {
  const links = new Set<string>();
  const html = renderMarkdown(markdown).html;
  for (const match of html.matchAll(/<a\b[^>]*href="([^"]+)"/g)) {
    try {
      const url = new URL(match[1].replace(/&amp;/g, '&'), `https://${domain}`);
      if (url.hostname === domain) links.add(decodeURI(url.pathname).replace(/\/$/, '') || '/');
    } catch {}
  }
  return [...links];
}
