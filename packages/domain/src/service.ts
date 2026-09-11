import { Database, type Actor, type Site, type Post } from '../../db/src/index';
import { authorize, isAuthor, passwordHash, allScopes } from '../../auth/src/index';
import {
  siteInput,
  siteUpdate,
  postInput,
  postUpdate,
  seoInput,
  snippetInput,
  redirectInput,
  slug,
  parse,
} from '../../api-contracts/src/index';
import {
  fail,
  id,
  now,
  normalizeHost,
  safeURL,
  hash,
  type Env,
  type Job,
} from '../../shared/src/index';
import { internalLinks } from '../../content/src/index';
import { z } from 'zod';
export class Service {
  database: Database;
  constructor(
    public env: Env,
    public actor: Actor,
    public requestId: string,
  ) {
    this.database = new Database(env.DB);
  }
  async access(scope: string, siteId?: string) {
    await authorize(this.database, this.actor, scope, siteId);
    if (siteId && !(await this.database.site(siteId))) fail(404, 'not_found', 'Site not found');
  }
  audit(siteId: string | null, action: string, resource: string, before: unknown, after: unknown) {
    return this.database.audit(this.actor, this.requestId, siteId, action, resource, before, after);
  }
  async commit(statements: D1PreparedStatement[], siteId?: string) {
    if (siteId) statements.push(this.database.forSite(siteId).bump());
    try {
      await this.env.DB.batch(statements);
    } catch (e) {
      const message = String(e);
      if (message.includes('CHECK constraint failed: valid=1'))
        fail(409, 'version_conflict', 'This record changed. Reload before saving.');
      if (message.includes('UNIQUE constraint failed'))
        fail(409, 'duplicate', 'This hostname, slug or record already exists');
      throw e;
    }
  }
  guard() {
    const key = id();
    return [
      this.env.DB.prepare(
        'INSERT INTO mutation_guards VALUES (?, CASE WHEN changes()=1 THEN 1 ELSE 0 END)',
      ).bind(key),
      this.env.DB.prepare('DELETE FROM mutation_guards WHERE id=?').bind(key),
    ];
  }
  async listSites(limit = 50, cursor = '') {
    if (this.actor.type === 'user' && !this.actor.superAdmin)
      return (
        await this.env.DB.prepare(
          'SELECT s.* FROM sites s JOIN site_memberships m ON s.id=m.site_id WHERE m.user_id=? AND s.id>? ORDER BY s.id LIMIT ?',
        )
          .bind(this.actor.id, cursor, limit)
          .all<Site>()
      ).results;
    await this.access('sites:read', this.actor.siteId);
    return (
      await this.env.DB.prepare(
        `SELECT * FROM sites WHERE id>? ${this.actor.siteId ? 'AND id=?' : ''} ORDER BY id LIMIT ?`,
      )
        .bind(cursor, ...(this.actor.siteId ? [this.actor.siteId] : []), limit)
        .all<Site>()
    ).results;
  }
  async getSite(siteId: string) {
    await this.access('sites:read', siteId);
    return this.database.site(siteId);
  }
  async createSite(input: unknown) {
    await this.access('system:admin');
    const data = parse(siteInput, input);
    const domain = normalizeHost(data.primary_domain);
    if (
      domain.includes(':') ||
      domain === this.env.ADMIN_HOST ||
      (!domain.includes('.') && domain !== 'localhost')
    )
      fail(422, 'invalid_domain', 'Use a tenant domain distinct from the admin hostname');
    try {
      new Intl.DateTimeFormat('en', { timeZone: data.timezone });
    } catch {
      fail(422, 'timezone', 'Invalid timezone');
    }
    const siteId = id(),
      time = now(),
      domainId = id(),
      token = id(),
      menuId = id();
    await this.commit([
      this.env.DB.prepare(
        'INSERT INTO sites(id,name,primary_domain,site_title,description,locale,timezone,theme_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        siteId,
        data.name,
        domain,
        data.site_title,
        data.description,
        data.locale,
        data.timezone,
        data.theme_id,
        time,
        time,
      ),
      this.env.DB.prepare(
        "INSERT INTO site_domains(id,site_id,hostname,type,verification_token) VALUES (?,?,?,'primary',?)",
      ).bind(domainId, siteId, domain, token),
      this.env.DB.prepare('INSERT INTO theme_settings VALUES (?,?)').bind(siteId, '{}'),
      this.env.DB.prepare('INSERT INTO navigation_menus VALUES (?,?,?)').bind(
        menuId,
        siteId,
        'main',
      ),
      this.env.DB.prepare('INSERT INTO navigation_items VALUES (?,?,?,?,?,?)').bind(
        id(),
        siteId,
        menuId,
        'Trang chủ',
        '/',
        0,
      ),
      this.audit(siteId, 'site.create', siteId, null, { ...data, primary_domain: domain }),
    ]);
    return {
      ...(await this.database.site(siteId)),
      domain_verification: {
        id: domainId,
        name: `_penlum.${domain}`,
        type: 'TXT',
        value: `penlum-verification=${token}`,
      },
    };
  }
  async updateSite(siteId: string, input: unknown) {
    await this.access('sites:write', siteId);
    const data = parse(siteUpdate, input);
    const before = await this.database.site(siteId);
    const { version, ...fields } = data;
    for (const k of ['logo', 'favicon', 'default_og'] as const) if (fields[k]) safeURL(fields[k]!);
    if (fields.timezone)
      try {
        new Intl.DateTimeFormat('en', { timeZone: fields.timezone });
      } catch {
        fail(422, 'timezone', 'Invalid timezone');
      }
    const entries = Object.entries(fields);
    if (!entries.length) return before;
    await this.commit(
      [
        this.env.DB.prepare(
          `UPDATE sites SET ${entries.map(([k]) => `${k}=?`).join(',')},version=version+1,updated_at=? WHERE id=? AND version=?`,
        ).bind(...entries.map(([, v]) => v), now(), siteId, version),
        ...this.guard(),
        this.audit(siteId, 'site.update', siteId, before, fields),
      ],
      siteId,
    );
    return this.database.site(siteId);
  }
  async siteStatus(siteId: string, status: 'active' | 'archived') {
    await this.access('sites:write', siteId);
    const before = await this.database.site(siteId);
    if (status === 'active') {
      const domain = await this.env.DB.prepare(
        "SELECT id FROM site_domains WHERE site_id=? AND type='primary' AND status='verified' AND verified_at IS NOT NULL",
      )
        .bind(siteId)
        .first();
      if (!domain) fail(422, 'domain_unverified', 'Verify the primary domain before activation');
    }
    await this.commit(
      [
        this.env.DB.prepare(
          'UPDATE sites SET status=?,version=version+1,updated_at=? WHERE id=?',
        ).bind(status, now(), siteId),
        this.audit(siteId, `site.${status}`, siteId, before, { status }),
      ],
      siteId,
    );
    return this.database.site(siteId);
  }
  async domains(siteId: string) {
    await this.access('sites:read', siteId);
    return (
      await this.env.DB.prepare('SELECT * FROM site_domains WHERE site_id=? ORDER BY hostname')
        .bind(siteId)
        .all()
    ).results;
  }
  async addDomain(siteId: string, input: unknown) {
    await this.access('sites:write', siteId);
    const data = parse(
      z.object({ hostname: z.string(), redirect_to_primary: z.boolean().default(true) }).strict(),
      input,
    );
    const hostname = normalizeHost(data.hostname);
    if (hostname === this.env.ADMIN_HOST) fail(422, 'invalid_domain', 'Reserved admin hostname');
    const domain = {
      id: id(),
      site_id: siteId,
      hostname,
      type: 'alias',
      verification_token: id(),
      redirect_to_primary: Number(data.redirect_to_primary),
    };
    await this.commit(
      [
        this.env.DB.prepare(
          'INSERT INTO site_domains(id,site_id,hostname,type,verification_token,redirect_to_primary) VALUES (?,?,?,?,?,?)',
        ).bind(...Object.values(domain)),
        this.audit(siteId, 'domain.add', domain.id, null, domain),
      ],
      siteId,
    );
    return domain;
  }
  async verifyDomain(siteId: string, domainId: string) {
    await this.access('sites:write', siteId);
    const domain = await this.env.DB.prepare('SELECT * FROM site_domains WHERE site_id=? AND id=?')
      .bind(siteId, domainId)
      .first<{ hostname: string; verification_token: string }>();
    if (!domain) return fail(404, 'not_found', 'Domain not found');
    const local = this.env.ENVIRONMENT === 'development' && domain.hostname.endsWith('.localhost');
    if (!local) {
      const response = await fetch(
        `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent('_penlum.' + domain.hostname)}&type=TXT`,
        { headers: { accept: 'application/dns-json' } },
      );
      if (!response.ok) fail(502, 'dns_error', 'DNS verification unavailable');
      const answer = (await response.json()) as { Answer?: { type: number; data: string }[] };
      if (
        !answer.Answer?.some(
          (a) =>
            a.type === 16 &&
            a.data.replace(/"\s*"/g, '').replace(/^"|"$/g, '') ===
              `penlum-verification=${domain.verification_token}`,
        )
      )
        fail(422, 'domain_unverified', 'Expected DNS TXT record was not found');
    }
    await this.commit(
      [
        this.env.DB.prepare(
          "UPDATE site_domains SET status='verified',verified_at=? WHERE site_id=? AND id=?",
        ).bind(now(), siteId, domainId),
        this.audit(siteId, 'domain.verify', domainId, null, { verified: true, local }),
      ],
      siteId,
    );
    return { verified: true };
  }
  async deleteDomain(siteId: string, domainId: string) {
    await this.access('sites:write', siteId);
    const before = await this.env.DB.prepare('SELECT * FROM site_domains WHERE site_id=? AND id=?')
      .bind(siteId, domainId)
      .first();
    if (!before) fail(404, 'not_found', 'Domain not found');
    if (before?.type === 'primary') fail(422, 'primary_domain', 'Cannot remove the primary domain');
    await this.commit(
      [
        this.env.DB.prepare('DELETE FROM site_domains WHERE site_id=? AND id=?').bind(
          siteId,
          domainId,
        ),
        this.audit(siteId, 'domain.delete', domainId, before, null),
      ],
      siteId,
    );
    return { deleted: true };
  }
  async listPosts(siteId: string, limit = 50, cursor = '', status?: string, search?: string) {
    await this.access('content:read', siteId);
    return this.database
      .forSite(siteId)
      .posts(
        limit,
        cursor,
        status,
        search,
        (await isAuthor(this.database, this.actor, siteId)) ? this.actor.id : undefined,
      );
  }
  async getPost(siteId: string, postId: string, scope = 'content:read') {
    await this.access(scope, siteId);
    const post = await this.database.forSite(siteId).post(postId);
    if (!post) return fail(404, 'not_found', 'Post not found');
    if ((await isAuthor(this.database, this.actor, siteId)) && post.author_id !== this.actor.id)
      fail(403, 'author_denied', 'Authors can access only their own posts');
    const category_ids = (
      await this.database
        .forSite(siteId)
        .statement('SELECT category_id FROM post_categories WHERE site_id=? AND post_id=?', postId)
        .all<{ category_id: string }>()
    ).results.map((row) => row.category_id);
    return { ...post, category_ids };
  }
  async relations(siteId: string, postId: string, categoryIds: string[], featured?: string | null) {
    const repo = this.database.forSite(siteId);
    if (
      featured &&
      !(await repo.statement('SELECT id FROM media WHERE site_id=? AND id=?', featured).first())
    )
      fail(422, 'media_scope', 'Media not found in this site');
    const statements = [
      repo.statement('DELETE FROM post_categories WHERE site_id=? AND post_id=?', postId),
    ];
    for (const categoryId of new Set(categoryIds)) {
      if (
        !(await repo
          .statement('SELECT id FROM categories WHERE site_id=? AND id=?', categoryId)
          .first())
      )
        fail(422, 'category_scope', 'Category not found in this site');
      statements.push(
        repo.statement(
          'INSERT INTO post_categories(site_id,post_id,category_id) VALUES (?,?,?)',
          postId,
          categoryId,
        ),
      );
    }
    return statements;
  }
  async linkStatements(siteId: string, postId: string, markdown: string) {
    const site = (await this.database.site(siteId))!;
    const repo = this.database.forSite(siteId);
    return [
      repo.statement('DELETE FROM internal_links WHERE site_id=? AND source_id=?', postId),
      ...internalLinks(markdown, site.primary_domain)
        .slice(0, 200)
        .map((path) => repo.statement('INSERT INTO internal_links VALUES (?,?,?)', postId, path)),
    ];
  }
  async createPost(siteId: string, input: unknown) {
    await this.access('content:write', siteId);
    const data = parse(postInput, input);
    const postId = id(),
      time = now();
    if (
      await this.database
        .forSite(siteId)
        .statement('SELECT id FROM redirects WHERE site_id=? AND source_path=?', '/' + data.slug)
        .first()
    )
      fail(409, 'redirect_collision', 'Remove the redirect at this path first');
    const relations = await this.relations(siteId, postId, data.category_ids, data.featured_media);
    await this.commit(
      [
        this.env.DB.prepare(
          'INSERT INTO posts(id,site_id,type,title,slug,excerpt,markdown_content,author_id,featured_media,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(
          postId,
          siteId,
          data.type,
          data.title,
          data.slug,
          data.excerpt,
          data.markdown_content,
          this.actor.id,
          data.featured_media ?? null,
          time,
          time,
        ),
        ...relations,
        ...(await this.linkStatements(siteId, postId, data.markdown_content)),
        this.audit(siteId, 'post.create', postId, null, data),
      ],
      siteId,
    );
    return this.getPost(siteId, postId);
  }
  async updatePost(siteId: string, postId: string, input: unknown) {
    const before = await this.getPost(siteId, postId, 'content:write');
    const data = parse(postUpdate, input);
    if (before.status === 'published' || before.status === 'scheduled')
      await this.access('content:publish', siteId);
    const { version, category_ids, ...fields } = data;
    const entries = Object.entries(fields);
    const repo = this.database.forSite(siteId);
    let relations: D1PreparedStatement[] = [];
    if (category_ids)
      relations = await this.relations(siteId, postId, category_ids, data.featured_media);
    else if (
      data.featured_media &&
      !(await repo
        .statement('SELECT id FROM media WHERE site_id=? AND id=?', data.featured_media)
        .first())
    )
      fail(422, 'media_scope', 'Media not found in this site');
    if (data.slug && data.slug !== before.slug) {
      if (
        await repo
          .statement('SELECT id FROM redirects WHERE site_id=? AND source_path=?', '/' + data.slug)
          .first()
      )
        fail(409, 'redirect_collision', 'New slug conflicts with an existing redirect');
      // Flatten redirects to the old path before recording the slug change.
      relations.push(
        this.env.DB.prepare('UPDATE redirects SET target=? WHERE site_id=? AND target=?').bind(
          '/' + data.slug,
          siteId,
          '/' + before.slug,
        ),
      );
      if (before.published_at)
        relations.push(
          this.env.DB.prepare(
            'INSERT INTO redirects(id,site_id,source_path,target) VALUES (?,?,?,?) ON CONFLICT(site_id,source_path) DO UPDATE SET target=excluded.target,enabled=1,status_code=301',
          ).bind(id(), siteId, '/' + before.slug, '/' + data.slug),
        );
    }
    await this.commit(
      [
        this.env.DB.prepare(
          `UPDATE posts SET ${entries.length ? entries.map(([k]) => `${k}=?`).join(',') + ',' : ''}version=version+1,updated_at=? WHERE site_id=? AND id=? AND version=?`,
        ).bind(...entries.map(([, v]) => v), now(), siteId, postId, version),
        ...this.guard(),
        ...relations,
        ...(data.markdown_content !== undefined
          ? await this.linkStatements(siteId, postId, data.markdown_content)
          : []),
        this.audit(siteId, 'post.update', postId, before, data),
      ],
      siteId,
    );
    return this.getPost(siteId, postId);
  }
  async publish(siteId: string, postId: string, input: unknown = {}) {
    const before = await this.getPost(siteId, postId, 'content:publish');
    const data = parse(
      z
        .object({ scheduled_at: z.iso.datetime().optional(), version: z.number().int().optional() })
        .strict(),
      input,
    );
    const site = (await this.database.site(siteId))!;
    if (site.status === 'archived') fail(422, 'site_archived', 'Archived sites cannot publish');
    if (data.scheduled_at && data.scheduled_at <= now())
      fail(422, 'schedule', 'Schedule must be in the future');
    const status = data.scheduled_at ? 'scheduled' : 'published';
    await this.commit(
      [
        this.env.DB.prepare(
          'UPDATE posts SET status=?,published_at=?,scheduled_at=?,updated_at=?,version=version+1 WHERE site_id=? AND id=? AND version=?',
        ).bind(
          status,
          data.scheduled_at ? before.published_at : before.published_at || now(),
          data.scheduled_at ?? null,
          now(),
          siteId,
          postId,
          data.version ?? before.version,
        ),
        ...this.guard(),
        this.audit(siteId, `post.${status}`, postId, before, {
          status,
          scheduled_at: data.scheduled_at,
        }),
      ],
      siteId,
    );
    return this.getPost(siteId, postId);
  }
  async unpublish(siteId: string, postId: string, remove = false) {
    const before = await this.getPost(siteId, postId, remove ? 'content:write' : 'content:publish');
    if (before.status === 'published' || before.status === 'scheduled')
      await this.access('content:publish', siteId);
    await this.commit(
      [
        this.env.DB.prepare(
          'UPDATE posts SET status=?,scheduled_at=NULL,deleted_at=?,version=version+1,updated_at=? WHERE site_id=? AND id=? AND version=?',
        ).bind(
          remove ? 'archived' : 'draft',
          remove ? now() : null,
          now(),
          siteId,
          postId,
          before.version,
        ),
        ...this.guard(),
        this.audit(siteId, remove ? 'post.delete' : 'post.unpublish', postId, before, null),
      ],
      siteId,
    );
    return { ok: true };
  }
  async seo(siteId: string, entityId: string, input?: unknown) {
    await this.access(input ? 'seo:write' : 'seo:read', siteId);
    const type = entityId === siteId ? 'site' : 'post';
    if (type === 'post') await this.getPost(siteId, entityId, input ? 'seo:write' : 'seo:read');
    const repo = this.database.forSite(siteId);
    const before = await repo
      .statement(
        'SELECT * FROM seo_meta WHERE site_id=? AND entity_type=? AND entity_id=?',
        type,
        entityId,
      )
      .first();
    if (input === undefined) return before || {};
    const data = parse(seoInput, input);
    if (data.canonical_override) safeURL(data.canonical_override, false);
    if (data.og_image) safeURL(data.og_image, false);
    let schema: unknown;
    try {
      schema = JSON.parse(data.schema_overrides_json);
    } catch {
      fail(422, 'schema', 'Invalid schema JSON');
    }
    // Only descriptive values; no fabricated ratings, identity or credentials.
    const overrides = parse(
      z
        .object({
          about: z.string().max(1000).optional(),
          keywords: z.array(z.string()).max(30).optional(),
        })
        .strict(),
      schema,
    );
    const merged = { ...before, ...data, schema_overrides_json: JSON.stringify(overrides) };
    const keys = [
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
    ];
    await this.commit(
      [
        this.env.DB.prepare(
          `INSERT INTO seo_meta(site_id,entity_type,entity_id,${keys.join(',')}) VALUES (?,?,?,${keys.map(() => '?').join(',')}) ON CONFLICT(site_id,entity_type,entity_id) DO UPDATE SET ${keys.map((k) => `${k}=excluded.${k}`).join(',')}`,
        ).bind(
          siteId,
          type,
          entityId,
          ...keys.map((k) =>
            typeof merged[k as keyof typeof merged] === 'boolean'
              ? Number(merged[k as keyof typeof merged])
              : (merged[k as keyof typeof merged] ?? null),
          ),
        ),
        this.audit(siteId, 'seo.update', entityId, before, merged),
      ],
      siteId,
    );
    return merged;
  }
  async redirect(siteId: string, input: unknown, redirectId?: string) {
    await this.access('seo:write', siteId);
    const data = parse(redirectInput, input);
    safeURL(data.target);
    const site = (await this.database.site(siteId))!;
    const targetURL = new URL(data.target, `https://${site.primary_domain}`);
    if (targetURL.hostname === site.primary_domain)
      data.target = targetURL.pathname + targetURL.search;
    if (
      ['/', '/robots.txt', '/sitemap.xml'].includes(data.source_path) ||
      /^\/(api|admin|mcp|media)(\/|$)/.test(data.source_path)
    )
      fail(422, 'reserved_path', 'Reserved path');
    const repo = this.database.forSite(siteId);
    if (
      await repo
        .statement(
          'SELECT id FROM posts WHERE site_id=? AND slug=? AND deleted_at IS NULL',
          data.source_path.slice(1),
        )
        .first()
    )
      fail(409, 'path_collision', 'A post already owns this path');
    const redirects = await repo.all<{
      id: string;
      source_path: string;
      target: string;
      enabled: number;
    }>('redirects', 10000);
    const map = new Map(
      redirects
        .filter((r) => r.enabled && r.id !== redirectId)
        .map((r) => [r.source_path, r.target]),
    );
    map.set(data.source_path, data.target);
    for (const source of map.keys()) {
      let next = source;
      const seen = new Set<string>();
      while (map.has(next)) {
        if (seen.has(next)) fail(422, 'redirect_loop', 'Redirect would create a loop');
        seen.add(next);
        next = map.get(next)!;
        if (seen.size > 1)
          fail(422, 'redirect_chain', 'Point redirects directly at their final destination');
      }
    }
    const rid = redirectId || id();
    const before = redirectId
      ? await repo.statement('SELECT * FROM redirects WHERE site_id=? AND id=?', rid).first()
      : null;
    if (redirectId && !before) fail(404, 'not_found', 'Redirect not found');
    await this.commit(
      [
        this.env.DB.prepare(
          'INSERT INTO redirects(id,site_id,source_path,target,status_code,enabled) VALUES (?,?,?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET source_path=excluded.source_path,target=excluded.target,status_code=excluded.status_code,enabled=excluded.enabled',
        ).bind(rid, siteId, data.source_path, data.target, data.status_code, Number(data.enabled)),
        this.audit(siteId, 'redirect.save', rid, before, data),
      ],
      siteId,
    );
    return { id: rid, ...data };
  }
  async listResource(siteId: string, table: string, limit = 100, cursor = '') {
    const scopes: Record<string, string> = {
      categories: 'content:read',
      media: 'content:read',
      redirects: 'seo:read',
      code_snippets: 'code:write',
      seo_audit_results: 'seo:read',
      site_memberships: 'users:read',
      theme_settings: 'sites:read',
      navigation_menus: 'sites:read',
      navigation_items: 'sites:read',
      analytics_sync_state: 'analytics:read',
    };
    if (!scopes[table]) return fail(404, 'not_found', 'Resource not found');
    await this.access(scopes[table], siteId);
    return this.database.forSite(siteId).all(table, limit, cursor);
  }
  async category(siteId: string, input: unknown, categoryId?: string) {
    await this.access('content:write', siteId);
    const data = parse(
      z
        .object({
          name: z.string().min(1).max(120),
          slug,
          description: z.string().max(1000).default(''),
        })
        .strict(),
      input,
    );
    const cid = categoryId || id();
    const repo = this.database.forSite(siteId);
    const before = categoryId
      ? await repo.statement('SELECT * FROM categories WHERE site_id=? AND id=?', cid).first()
      : null;
    if (categoryId && !before) fail(404, 'not_found', 'Category not found');
    await this.commit(
      [
        this.env.DB.prepare(
          'INSERT INTO categories VALUES (?,?,?,?,?) ON CONFLICT(site_id,id) DO UPDATE SET name=excluded.name,slug=excluded.slug,description=excluded.description',
        ).bind(cid, siteId, data.name, data.slug, data.description),
        this.audit(siteId, 'category.save', cid, before, data),
      ],
      siteId,
    );
    return { id: cid, ...data };
  }
  async deleteResource(
    siteId: string,
    table: 'categories' | 'redirects' | 'media',
    resourceId: string,
  ) {
    await this.access(
      table === 'redirects' ? 'seo:write' : table === 'media' ? 'media:write' : 'content:write',
      siteId,
    );
    const repo = this.database.forSite(siteId);
    const before = await repo
      .statement(`SELECT * FROM ${table} WHERE site_id=? AND id=?`, resourceId)
      .first();
    if (!before) return fail(404, 'not_found', 'Resource not found');
    const statements = [];
    if (table === 'categories')
      statements.push(
        repo.statement('DELETE FROM post_categories WHERE site_id=? AND category_id=?', resourceId),
      );
    if (
      table === 'media' &&
      (await repo
        .statement(
          'SELECT id FROM posts WHERE site_id=? AND featured_media=? AND deleted_at IS NULL',
          resourceId,
        )
        .first())
    )
      fail(409, 'media_in_use', 'Remove the featured-image references before deleting this media');
    statements.push(
      repo.statement(`DELETE FROM ${table} WHERE site_id=? AND id=?`, resourceId),
      this.audit(siteId, `${table}.delete`, resourceId, before, null),
    );
    await this.commit(statements, siteId);
    // R2 bytes remain private for retention; export/housekeeping policies own physical deletion.
    return { deleted: true };
  }
  async snippet(siteId: string | null, input: unknown, snippetId?: string) {
    await this.access(siteId ? 'code:write' : 'system:admin', siteId ?? undefined);
    const data = parse(snippetInput, input);
    if (data.executable && !this.actor.superAdmin)
      fail(403, 'executable_code', 'Only super administrators can execute code');
    if (siteId === null && data.confirmation !== 'APPLY GLOBAL CODE')
      fail(422, 'confirmation', 'Global changes require confirmation: APPLY GLOBAL CODE');
    if (data.executable && /<script\b[^>]*\bsrc\s*=/i.test(data.content))
      fail(422, 'csp', 'External executable scripts are disabled by the V1 CSP');
    const sid = snippetId || id();
    const before = snippetId
      ? await this.env.DB.prepare('SELECT * FROM code_snippets WHERE id=? AND site_id IS ?')
          .bind(sid, siteId)
          .first<{ version: number }>()
      : null;
    if (snippetId && !before) fail(404, 'not_found', 'Snippet not found');
    if (before && data.version !== before.version)
      fail(409, 'version_conflict', 'Reload the snippet before saving');
    const statements: D1PreparedStatement[] = [];
    if (before)
      statements.push(
        this.env.DB.prepare(
          'UPDATE code_snippets SET name=?,placement=?,targeting=?,priority=?,enabled=?,executable=?,content=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND site_id IS ? AND version=?',
        ).bind(
          data.name,
          data.placement,
          JSON.stringify(data.targeting),
          data.priority,
          Number(data.enabled),
          Number(data.executable),
          data.content,
          now(),
          this.actor.id,
          sid,
          siteId,
          data.version!,
        ),
        ...this.guard(),
        this.env.DB.prepare('INSERT INTO snippet_revisions VALUES (?,?,?,?,?,?)').bind(
          id(),
          sid,
          before.version,
          JSON.stringify(before),
          now(),
          this.actor.id,
        ),
      );
    else
      statements.push(
        this.env.DB.prepare(
          'INSERT INTO code_snippets(id,site_id,name,placement,targeting,priority,enabled,executable,content,updated_at,updated_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        ).bind(
          sid,
          siteId,
          data.name,
          data.placement,
          JSON.stringify(data.targeting),
          data.priority,
          Number(data.enabled),
          Number(data.executable),
          data.content,
          now(),
          this.actor.id,
        ),
      );
    statements.push(this.audit(siteId, 'snippet.save', sid, before, data));
    if (!siteId)
      statements.push(
        this.env.DB.prepare(
          "UPDATE system_state SET value=CAST(value AS INTEGER)+1 WHERE key='global_cache_version'",
        ),
      );
    await this.commit(statements, siteId ?? undefined);
    return { id: sid, ...data, version: (before?.version || 0) + 1 };
  }
  async enqueue(type: Job['type'], siteId: string) {
    await this.access(type === 'audit' ? 'seo:write' : 'sites:write', siteId);
    const job: Job = { id: id(), site_id: siteId, type };
    const time = now();
    await this.commit(
      [
        this.env.DB.prepare(
          'INSERT INTO jobs(id,site_id,type,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        ).bind(job.id, siteId, type, JSON.stringify(job), time, time),
        this.audit(siteId, `job.${type}`, job.id, null, job),
      ],
      type === 'purge' ? siteId : undefined,
    );
    // Transactional outbox: cron dispatches a queued job again if send fails.
    try {
      await this.env.JOBS.send(job);
    } catch {}
    return job;
  }
  async createUser(input: unknown) {
    await this.access('system:admin');
    const data = parse(
      z
        .object({
          email: z.email(),
          display_name: z.string().min(1).max(120),
          password: z.string().min(12).max(128),
          role: z.enum(['member', 'super_admin']).default('member'),
        })
        .strict(),
      input,
    );
    const uid = id();
    await this.commit([
      this.env.DB.prepare(
        'INSERT INTO users(id,email,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)',
      ).bind(
        uid,
        data.email.toLowerCase(),
        data.display_name,
        await passwordHash(data.password),
        data.role,
        now(),
      ),
      this.audit(null, 'user.create', uid, null, {
        email: data.email,
        display_name: data.display_name,
        role: data.role,
      }),
    ]);
    return { id: uid, email: data.email, display_name: data.display_name, role: data.role };
  }
  async membership(siteId: string, input: unknown) {
    await this.access('users:write', siteId);
    const data = parse(
      z
        .object({
          user_id: z.string(),
          role: z.enum(['site_admin', 'editor', 'author', 'analyst', 'viewer']),
        })
        .strict(),
      input,
    );
    if (!(await this.env.DB.prepare('SELECT id FROM users WHERE id=?').bind(data.user_id).first()))
      fail(404, 'not_found', 'User not found');
    const before = await this.env.DB.prepare(
      'SELECT * FROM site_memberships WHERE site_id=? AND user_id=?',
    )
      .bind(siteId, data.user_id)
      .first();
    await this.commit([
      this.env.DB.prepare(
        'INSERT INTO site_memberships VALUES (?,?,?) ON CONFLICT(site_id,user_id) DO UPDATE SET role=excluded.role',
      ).bind(siteId, data.user_id, data.role),
      this.audit(siteId, 'membership.save', data.user_id, before, data),
    ]);
    return data;
  }
  async credential(input: unknown) {
    await this.access('system:admin');
    const data = parse(
      z
        .object({
          name: z.string().min(1).max(120),
          type: z.enum(['system', 'site', 'service']),
          site_id: z.string().optional(),
          scopes: z.array(z.enum(allScopes as [string, ...string[]])).min(1),
          expires_at: z.iso.datetime().optional(),
        })
        .strict(),
      input,
    );
    if (data.type !== 'system' && !data.site_id)
      fail(422, 'site_required', 'Site/service credentials require site_id');
    if (data.type !== 'system' && data.scopes.includes('system:admin'))
      fail(422, 'scope', 'Only system credentials may administer the system');
    if (data.type === 'system' && data.site_id)
      fail(422, 'scope', 'System credential must not have a site binding');
    if (data.site_id && !(await this.database.site(data.site_id)))
      fail(404, 'not_found', 'Site not found');
    if (data.expires_at && data.expires_at <= now())
      fail(422, 'expiry', 'Expiry must be in the future');
    const token = 'penlum_' + id().replace(/-/g, '') + id().replace(/-/g, '');
    const cid = id();
    await this.commit([
      this.env.DB.prepare(
        'INSERT INTO api_credentials(id,name,hash,type,site_id,scopes,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).bind(
        cid,
        data.name,
        await hash(token),
        data.type,
        data.site_id ?? null,
        JSON.stringify(data.scopes),
        data.expires_at ?? null,
        now(),
      ),
      this.audit(data.site_id ?? null, 'credential.create', cid, null, data),
    ]);
    return { id: cid, token, ...data };
  }
}
