import { Database, type Post } from '../../db/src/index';
import { Service } from './service';
import { runAudit } from '../../seo/src/audit';
import { syncGSC } from '../../analytics/src/index';
import { id, now, type Env, type Job } from '../../shared/src/index';
export const systemActor = {
  id: 'scheduler',
  type: 'system' as const,
  superAdmin: true,
  scopes: ['system:admin'],
};
export async function exportTenant(env: Env, siteId: string) {
  const db = new Database(env.DB);
  const site = await db.site(siteId);
  const tables = [
    'posts',
    'categories',
    'post_categories',
    'media',
    'seo_meta',
    'redirects',
    'code_snippets',
    'theme_settings',
    'navigation_menus',
    'navigation_items',
  ];
  const data: Record<string, unknown> = { format: 'penlum-tenant-v1', exported_at: now(), site };
  for (const table of tables)
    data[table] = (
      await env.DB.prepare(`SELECT * FROM ${table} WHERE site_id=?`).bind(siteId).all()
    ).results;
  return data;
}
export async function executeJob(env: Env, job: Job) {
  const stored = await env.DB.prepare('SELECT status FROM jobs WHERE id=?')
    .bind(job.id)
    .first<{ status: string }>();
  if (stored?.status === 'completed') return;
  await env.DB.prepare(
    "UPDATE jobs SET status='running',attempts=attempts+1,updated_at=? WHERE id=?",
  )
    .bind(now(), job.id)
    .run();
  try {
    if (job.type === 'audit' && job.site_id) await runAudit(env, job.site_id);
    if (job.type === 'export' && job.site_id)
      await env.MEDIA.put(
        `${job.site_id}/exports/${job.id}.json`,
        JSON.stringify(await exportTenant(env, job.site_id)),
        { httpMetadata: { contentType: 'application/json' } },
      );
    if (job.type === 'analytics' && job.site_id)
      await syncGSC(
        env,
        job.site_id,
        job.date || new Date(Date.now() - 3 * 86400000).toISOString().slice(0, 10),
      );
    await env.DB.batch([
      env.DB.prepare("UPDATE jobs SET status='completed',error=NULL,updated_at=? WHERE id=?").bind(
        now(),
        job.id,
      ),
      new Database(env.DB).audit(
        systemActor,
        job.id,
        job.site_id || null,
        'job.completed',
        job.id,
        null,
        { type: job.type },
      ),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Job failed';
    await env.DB.prepare("UPDATE jobs SET status='failed',error=?,updated_at=? WHERE id=?")
      .bind(message.slice(0, 500), now(), job.id)
      .run();
    if (job.type === 'analytics')
      await env.DB.prepare('UPDATE analytics_sync_state SET error=? WHERE site_id=?')
        .bind(message.slice(0, 500), job.site_id!)
        .run();
    throw error;
  }
}
export async function scheduled(env: Env, cron: string) {
  const service = new Service(env, systemActor, id());
  const due = (
    await env.DB.prepare(
      "SELECT p.* FROM posts p JOIN sites s ON s.id=p.site_id WHERE p.status='scheduled' AND p.scheduled_at<=? AND p.deleted_at IS NULL AND s.status!='archived' LIMIT 100",
    )
      .bind(now())
      .all<Post>()
  ).results;
  for (const post of due) await service.publish(post.site_id, post.id, { version: post.version });
  if (cron === '15 6 * * *') {
    const connected = (
      await env.DB.prepare(
        'SELECT site_id FROM analytics_sync_state WHERE property IS NOT NULL',
      ).all<{ site_id: string }>()
    ).results;
    for (const row of connected)
      for (let days = 3; days <= 5; days++) {
        const job: Job = {
          id: id(),
          site_id: row.site_id,
          type: 'analytics',
          date: new Date(Date.now() - days * 86400000).toISOString().slice(0, 10),
        };
        await env.DB.prepare(
          'INSERT INTO jobs(id,site_id,type,payload,created_at,updated_at) VALUES (?,?,?,?,?,?)',
        )
          .bind(job.id, row.site_id, job.type, JSON.stringify(job), now(), now())
          .run();
      }
  }
  const queued = (
    await env.DB.prepare(
      "SELECT payload FROM jobs WHERE status='queued' OR (status='running' AND updated_at<?) LIMIT 100",
    )
      .bind(new Date(Date.now() - 15 * 60000).toISOString())
      .all<{ payload: string }>()
  ).results;
  for (const row of queued) await env.JOBS.send(JSON.parse(row.payload));
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE expires_at<?').bind(now()),
    env.DB.prepare('DELETE FROM rate_limits WHERE window<?').bind(
      Math.floor(Date.now() / 60000) - 60,
    ),
    env.DB.prepare('DELETE FROM idempotency_keys WHERE expires_at<?').bind(now()),
    env.DB.prepare(
      "INSERT INTO system_state VALUES ('cron_last_run',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    ).bind(now()),
  ]);
}
