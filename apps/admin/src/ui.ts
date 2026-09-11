export const escapeHTML = (value: unknown) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
export const icon = (name: string) => `<i class="fa-solid fa-${name}" aria-hidden="true"></i>`;
export const iconButton = (name: string, label: string, id: string) =>
  `<button type="button" class="icon-button" id="${id}" aria-label="${escapeHTML(label)}" title="${escapeHTML(label)}">${icon(name)}</button>`;
export function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 160)
    .replace(/-$/, '');
}
export const readingStats = (markdown: string) => {
  const words = markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/[#*_`>|~\[\]()]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return { words, minutes: Math.max(1, Math.ceil(words / 220)) };
};
export const publicURL = (domain: string, path = '/') =>
  `${domain.endsWith('.localhost') ? 'http' : 'https'}://${domain}${domain.endsWith('.localhost') ? ':' + (location.port || '8787') : ''}${path}`;
export function contentToEditor(markdown: string, siteId: string) {
  return markdown.replace(
    /\]\(\/media\/([a-zA-Z0-9-]+)(?=[\s)])/g,
    `](/api/v1/sites/${siteId}/media/$1/file`,
  );
}
export function contentFromEditor(markdown: string, siteId: string) {
  const prefix = `/api/v1/sites/${siteId}/media/`;
  return markdown.replace(/\]\(([^)\s]+)(?=[\s)])/g, (match, url: string) =>
    url.startsWith(prefix) && /^[-a-zA-Z0-9]+\/file$/.test(url.slice(prefix.length))
      ? `](/media/${url.slice(prefix.length, -5)}`
      : match,
  );
}
// Serialize writes, take a fresh snapshot at execution time, and leave rejected
// writes visible to the caller. A failure never poisons subsequent save attempts.
export class SaveQueue {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(write: () => Promise<T>): Promise<T> {
    const next = this.tail.catch(() => {}).then(write);
    this.tail = next;
    return next;
  }
}
