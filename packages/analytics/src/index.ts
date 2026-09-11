import { Database, type Actor } from '../../db/src/index';
import { authorize } from '../../auth/src/index';
import { fail, now, type Env } from '../../shared/src/index';
export function delta(current: number, previous: number) {
  return {
    absolute: current - previous,
    percent: previous === 0 ? null : Math.round(((current - previous) / previous) * 10000) / 100,
  };
}
export function period(start: string, end: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    return fail(422, 'date_range', 'Use YYYY-MM-DD dates');
  const a = Date.parse(start),
    b = Date.parse(end);
  const days = Math.round((b - a) / 86400000) + 1;
  if (
    !Number.isFinite(days) ||
    days < 1 ||
    days > 366 ||
    new Date(a).toISOString().slice(0, 10) !== start ||
    new Date(b).toISOString().slice(0, 10) !== end
  )
    fail(422, 'date_range', 'Date range must be 1–366 valid days');
  return {
    start,
    end,
    previousStart: new Date(a - days * 86400000).toISOString().slice(0, 10),
    previousEnd: new Date(a - 86400000).toISOString().slice(0, 10),
  };
}
export async function performance(
  env: Env,
  actor: Actor,
  start: string,
  end: string,
  siteId?: string,
  mode = 'sites',
  minimum = 10,
) {
  const db = new Database(env.DB);
  if (siteId) await authorize(db, actor, 'analytics:read', siteId);
  else if (actor.type !== 'user' || actor.superAdmin)
    await authorize(db, actor, 'analytics:read', actor.siteId);
  const p = period(start, end);
  let access = '';
  const binds: unknown[] = [];
  if (siteId || actor.siteId) {
    access = 'AND a.site_id=?';
    binds.push(siteId || actor.siteId);
  } else if (actor.type === 'user' && !actor.superAdmin) {
    access =
      "AND a.site_id IN (SELECT site_id FROM site_memberships WHERE user_id=? AND role IN ('site_admin','analyst'))";
    binds.push(actor.id);
  }
  const table = mode === 'pages' ? 'analytics_daily_page' : 'analytics_daily_site';
  const group = mode === 'pages' ? 'a.site_id,a.path' : 'a.site_id';
  const rows = (
    await env.DB.prepare(
      `SELECT a.site_id,s.name,s.primary_domain,${mode === 'pages' ? 'a.path,' : ''} SUM(CASE WHEN date>=? THEN clicks ELSE 0 END) clicks,SUM(CASE WHEN date<? THEN clicks ELSE 0 END) previous_clicks,SUM(CASE WHEN date>=? THEN impressions ELSE 0 END) impressions,SUM(CASE WHEN date<? THEN impressions ELSE 0 END) previous_impressions,SUM(CASE WHEN date>=? THEN position*impressions ELSE 0 END)/NULLIF(SUM(CASE WHEN date>=? THEN impressions ELSE 0 END),0) position,SUM(CASE WHEN date<? THEN position*impressions ELSE 0 END)/NULLIF(SUM(CASE WHEN date<? THEN impressions ELSE 0 END),0) previous_position,MAX(sync.last_sync) last_sync FROM ${table} a JOIN sites s ON s.id=a.site_id LEFT JOIN analytics_sync_state sync ON sync.site_id=a.site_id WHERE date BETWEEN ? AND ? ${access} GROUP BY ${group} ORDER BY clicks DESC LIMIT 1000`,
    )
      .bind(start, start, start, start, start, start, start, start, p.previousStart, end, ...binds)
      .all<{
        site_id: string;
        name: string;
        primary_domain: string;
        path?: string;
        clicks: number;
        previous_clicks: number;
        impressions: number;
        previous_impressions: number;
        position: number | null;
        previous_position: number | null;
        last_sync: string | null;
      }>()
  ).results;
  const data = rows.map((r) => ({
    ...r,
    ctr: r.impressions ? r.clicks / r.impressions : 0,
    click_delta: delta(r.clicks, r.previous_clicks),
    impression_delta: delta(r.impressions, r.previous_impressions),
    position_delta:
      r.position !== null && r.previous_position !== null ? r.position - r.previous_position : null,
    anomaly:
      r.previous_clicks >= minimum && r.clicks < r.previous_clicks * 0.7 ? 'clicks_drop' : null,
  }));
  const eligible = data.filter((r) => Math.max(r.clicks, r.previous_clicks) >= minimum);
  return {
    period: p,
    sites: data,
    winners: eligible
      .filter((r) => r.click_delta.absolute > 0)
      .sort((a, b) => b.click_delta.absolute - a.click_delta.absolute),
    losers: eligible
      .filter((r) => r.click_delta.absolute < 0)
      .sort((a, b) => a.click_delta.absolute - b.click_delta.absolute),
  };
}
export async function syncGSC(env: Env, siteId: string, date: string) {
  period(date, date);
  if (!env.GSC_CLIENT_ID || !env.GSC_CLIENT_SECRET || !env.GSC_REFRESH_TOKEN)
    fail(422, 'gsc_unconfigured', 'Configure Google Search Console OAuth secrets');
  const state = await env.DB.prepare('SELECT property FROM analytics_sync_state WHERE site_id=?')
    .bind(siteId)
    .first<{ property: string }>();
  if (!state?.property) fail(422, 'gsc_property', 'Connect a Search Console property to this site');
  const site = (await new Database(env.DB).site(siteId))!;
  const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GSC_CLIENT_ID!,
      client_secret: env.GSC_CLIENT_SECRET!,
      refresh_token: env.GSC_REFRESH_TOKEN!,
      grant_type: 'refresh_token',
    }),
  });
  if (!tokenResponse.ok) fail(502, 'gsc_auth', 'Google token refresh failed');
  const token = (await tokenResponse.json()) as { access_token: string };
  const query = async (dimensions: string[], startRow = 0) => {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(state!.property)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token.access_token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          startDate: date,
          endDate: date,
          dimensions,
          rowLimit: 25000,
          startRow,
          dataState: 'final',
        }),
      },
    );
    if (!response.ok) fail(502, 'gsc_fetch', `Search Console returned ${response.status}`);
    return (await response.json()) as {
      rows?: { keys?: string[]; clicks: number; impressions: number; position: number }[];
    };
  };
  const total = (await query([])).rows?.[0] || { clicks: 0, impressions: 0, position: 0 };
  const pages = new Map<string, { clicks: number; impressions: number; weighted: number }>();
  for (let startRow = 0; startRow < 100000; startRow += 25000) {
    const result = await query(['page'], startRow);
    for (const r of result.rows || []) {
      try {
        const url = new URL(r.keys![0]);
        if (url.hostname !== site.primary_domain) continue;
        const path = url.pathname;
        const old = pages.get(path) || { clicks: 0, impressions: 0, weighted: 0 };
        pages.set(path, {
          clicks: old.clicks + r.clicks,
          impressions: old.impressions + r.impressions,
          weighted: old.weighted + r.position * r.impressions,
        });
      } catch {}
    }
    if ((result.rows?.length || 0) < 25000) break;
  }
  // Each site's V1 content volume is small. Reject unexpected volume before any
  // replacement so a partial sync never wipes a previously complete date.
  if (pages.size > 2000)
    fail(
      422,
      'gsc_volume',
      'Property exceeds V1 page limit; narrow the property or implement staged ingestion',
    );
  const statements = [
    env.DB.prepare('DELETE FROM analytics_daily_page WHERE site_id=? AND date=?').bind(
      siteId,
      date,
    ),
    ...Array.from(pages, ([path, r]) =>
      env.DB.prepare('INSERT INTO analytics_daily_page VALUES (?,?,?,?,?,?)').bind(
        siteId,
        date,
        path,
        r.clicks,
        r.impressions,
        r.impressions ? r.weighted / r.impressions : 0,
      ),
    ),
    env.DB.prepare(
      'INSERT INTO analytics_daily_site(site_id,date,clicks,impressions,position) VALUES (?,?,?,?,?) ON CONFLICT(site_id,date) DO UPDATE SET clicks=excluded.clicks,impressions=excluded.impressions,position=excluded.position',
    ).bind(siteId, date, total.clicks, total.impressions, total.position),
    env.DB.prepare(
      'UPDATE analytics_sync_state SET last_sync=?,last_date=?,error=NULL WHERE site_id=?',
    ).bind(now(), date, siteId),
  ];
  await env.DB.batch(statements);
}
