import { z } from 'zod';
import { fail, id, now } from '../../shared/src/index';
const columns: Record<string, string[]> = {
  sites: [
    'id',
    'name',
    'primary_domain',
    'status',
    'locale',
    'timezone',
    'theme_id',
    'site_title',
    'description',
    'logo',
    'favicon',
    'default_og',
    'robots_mode',
    'version',
    'cache_version',
    'created_at',
    'updated_at',
  ],
  posts: [
    'id',
    'site_id',
    'type',
    'status',
    'title',
    'slug',
    'excerpt',
    'markdown_content',
    'author_id',
    'featured_media',
    'published_at',
    'scheduled_at',
    'version',
    'created_at',
    'updated_at',
    'deleted_at',
  ],
  categories: ['id', 'site_id', 'name', 'slug', 'description'],
  post_categories: ['site_id', 'post_id', 'category_id'],
  media: [
    'id',
    'site_id',
    'r2_key',
    'filename',
    'mime',
    'width',
    'height',
    'bytes',
    'alt',
    'title',
    'caption',
    'checksum',
    'created_at',
  ],
  seo_meta: [
    'site_id',
    'entity_type',
    'entity_id',
    'seo_title',
    'description',
    'canonical_override',
    'noindex',
    'nofollow',
    'og_title',
    'og_description',
    'og_image',
    'schema_type',
    'schema_overrides_json',
  ],
  redirects: ['id', 'site_id', 'source_path', 'target', 'status_code', 'enabled'],
  code_snippets: [
    'id',
    'site_id',
    'name',
    'placement',
    'targeting',
    'priority',
    'enabled',
    'executable',
    'content',
    'version',
    'updated_at',
    'updated_by',
  ],
  theme_settings: ['site_id', 'settings'],
  navigation_menus: ['id', 'site_id', 'name'],
  navigation_items: ['id', 'site_id', 'menu_id', 'label', 'url', 'position'],
};
export const sqlValue = (value: unknown) =>
  value == null
    ? 'NULL'
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : `'${String(value).replace(/'/g, "''")}'`;
export function restoreSQL(input: unknown) {
  const snapshot = z
    .object({ format: z.literal('penlum-tenant-v1'), site: z.record(z.string(), z.unknown()) })
    .loose()
    .parse(input) as Record<string, any>;
  const site = snapshot.site;
  z.string().uuid().parse(site.id);
  z.string().min(1).parse(site.primary_domain);
  const statements: string[] = [];
  const insert = (table: string, row: Record<string, unknown>) => {
    const keys = Object.keys(row);
    if (keys.some((k) => !columns[table]?.includes(k)))
      fail(422, 'backup_column', 'Backup contains an unknown column');
    statements.push(
      `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map((k) => sqlValue(row[k])).join(',')});`,
    );
  };
  // Refuse overwrite by using INSERT (no REPLACE). Restores are staging/noindex,
  // all domains require re-verification and executable snippets are disabled.
  insert('sites', {
    ...site,
    status: 'staging',
    robots_mode: 'noindex',
    cache_version: Number(site.cache_version || 0) + 1,
    updated_at: now(),
  });
  const order = [
    'media',
    'posts',
    'categories',
    'post_categories',
    'seo_meta',
    'redirects',
    'code_snippets',
    'theme_settings',
    'navigation_menus',
    'navigation_items',
  ];
  for (const table of order) {
    const rows = z
      .array(z.record(z.string(), z.unknown()))
      .max(10000)
      .parse(snapshot[table] || []);
    for (const row of rows) {
      if (row.site_id !== site.id)
        fail(422, 'backup_scope', 'Backup contains data from another tenant');
      insert(table, table === 'code_snippets' ? { ...row, enabled: 0 } : row);
    }
  }
  statements.push(
    `INSERT INTO site_domains (id,site_id,hostname,type,verification_token,status) VALUES (${sqlValue(id())},${sqlValue(site.id)},${sqlValue(site.primary_domain)},'primary',${sqlValue(id())},'pending');`,
  );
  statements.push(
    `INSERT INTO audit_logs (id,site_id,actor_type,actor_id,action,resource,after_json,request_id,created_at) VALUES (${sqlValue(id())},${sqlValue(site.id)},'system','restore-cli','site.restore',${sqlValue(site.id)},'{"status":"staging"}',${sqlValue(id())},${sqlValue(now())});`,
  );
  return statements;
}
