import { id, now, fail } from '../../shared/src/index';
import type { Site, Post, Actor } from '../../shared/src/models';
export type { Site, Post, Actor } from '../../shared/src/models';
// All tenant reads and writes enter through this repository. A future router can
// select a D1 binding from the site ID without changing services or adapters.
export class Database {
  constructor(public db: D1Database) {}
  forSite(siteId: string) {
    if (!siteId) fail(400, 'site_required', 'Site ID required');
    return new TenantRepository(this.db, siteId);
  }
  async site(siteId: string) {
    return this.db.prepare('SELECT * FROM sites WHERE id=?').bind(siteId).first<Site>();
  }
  async resolve(host: string) {
    return this.db
      .prepare(
        "SELECT s.*,d.redirect_to_primary,d.hostname FROM site_domains d JOIN sites s ON s.id=d.site_id WHERE d.hostname=? AND d.status='verified' AND d.verified_at IS NOT NULL",
      )
      .bind(host)
      .first<Site & { redirect_to_primary: number; hostname: string }>();
  }
  audit(
    actor: Actor,
    requestId: string,
    siteId: string | null,
    action: string,
    resource: string,
    before: unknown,
    after: unknown,
  ) {
    return this.db
      .prepare('INSERT INTO audit_logs VALUES (?,?,?,?,?,?,?,?,?,?)')
      .bind(
        id(),
        siteId,
        actor.type,
        actor.id,
        action,
        resource,
        before == null ? null : JSON.stringify(before),
        after == null ? null : JSON.stringify(after),
        requestId,
        now(),
      );
  }
}
const tables = new Set([
  'posts',
  'categories',
  'media',
  'seo_meta',
  'redirects',
  'code_snippets',
  'theme_settings',
  'navigation_menus',
  'navigation_items',
  'site_memberships',
  'analytics_daily_site',
  'analytics_daily_page',
  'analytics_sync_state',
  'seo_audit_results',
  'internal_links',
  'post_categories',
]);
export class TenantRepository {
  constructor(
    public db: D1Database,
    public siteId: string,
  ) {}
  statement(sql: string, ...values: unknown[]) {
    return this.db.prepare(sql).bind(this.siteId, ...values);
  }
  async all<T = Record<string, unknown>>(table: string, limit = 100, cursor = '') {
    if (!tables.has(table)) fail(400, 'table', 'Unknown resource');
    return (
      await this.statement(
        `SELECT * FROM ${table} WHERE site_id=? ${cursor ? 'AND id>?' : ''} ${['posts', 'categories', 'media', 'redirects', 'code_snippets', 'seo_audit_results', 'navigation_menus', 'navigation_items'].includes(table) ? 'ORDER BY id' : ''} LIMIT ?`,
        ...(cursor ? [cursor] : []),
        limit,
      ).all<T>()
    ).results;
  }
  async post(postId: string) {
    return this.statement(
      'SELECT * FROM posts WHERE site_id=? AND id=? AND deleted_at IS NULL',
      postId,
    ).first<Post>();
  }
  async postBySlug(slug: string) {
    return this.statement(
      "SELECT * FROM posts WHERE site_id=? AND slug=? AND status='published' AND deleted_at IS NULL AND published_at<=?",
      slug,
      now(),
    ).first<Post>();
  }
  async posts(limit = 50, cursor = '', status?: string, search?: string, authorId?: string) {
    return (
      await this.statement(
        `SELECT * FROM posts WHERE site_id=? AND deleted_at IS NULL AND id>? ${status ? 'AND status=?' : ''} ${authorId ? 'AND author_id=?' : ''} ${search ? "AND (title LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')" : ''} ORDER BY id LIMIT ?`,
        cursor,
        ...(status ? [status] : []),
        ...(authorId ? [authorId] : []),
        ...(search ? Array(2).fill('%' + search.replace(/[\\%_]/g, '\\$&') + '%') : []),
        limit,
      ).all<Post>()
    ).results;
  }
  bump() {
    return this.statement('UPDATE sites SET cache_version=cache_version+1 WHERE id=?');
  }
}
