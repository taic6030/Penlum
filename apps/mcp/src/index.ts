import { Service } from '../../../packages/domain/src/service';
import { performance } from '../../../packages/analytics/src/index';
import { upload } from '../../../packages/domain/src/media';
import { AppError, fail } from '../../../packages/shared/src/index';
const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = { type: 'string' };
const site = { site_id: str };
const post = { ...site, post_id: str };
const input = { type: 'object' };
export const tools = [
  {
    name: 'list_sites',
    description: 'List authorized sites',
    inputSchema: object({ cursor: str }),
  },
  {
    name: 'get_site',
    description: 'Get one authorized site',
    inputSchema: object(site, ['site_id']),
  },
  {
    name: 'create_site',
    description: 'Create a staging site; does not provision DNS or buy a domain',
    inputSchema: object({ input }, ['input']),
  },
  {
    name: 'update_site',
    description: 'Update a site with optimistic version',
    inputSchema: object({ ...site, input }, ['site_id', 'input']),
  },
  {
    name: 'list_posts',
    description: 'List content for a site',
    inputSchema: object({ ...site, cursor: str }, ['site_id']),
  },
  {
    name: 'get_post',
    description: 'Read a post in a site',
    inputSchema: object(post, ['site_id', 'post_id']),
  },
  {
    name: 'create_post',
    description: 'Create a Markdown draft',
    inputSchema: object({ ...site, input }, ['site_id', 'input']),
  },
  {
    name: 'update_post',
    description: 'Update a post with optimistic version',
    inputSchema: object({ ...post, input }, ['site_id', 'post_id', 'input']),
  },
  {
    name: 'publish_post',
    description: 'Publish one post; requires content:publish',
    inputSchema: object({ ...post, input }, ['site_id', 'post_id']),
  },
  {
    name: 'upload_media',
    description: 'Upload a PNG, JPEG or GIF (base64), at most 2 MB over MCP',
    inputSchema: object({ ...site, filename: str, mime: str, base64: str, alt: str }, [
      'site_id',
      'filename',
      'mime',
      'base64',
    ]),
  },
  {
    name: 'get_seo',
    description: 'Read SEO; entity_id is the post ID or site ID',
    inputSchema: object({ ...site, entity_id: str }, ['site_id', 'entity_id']),
  },
  {
    name: 'update_seo',
    description: 'Update SEO',
    inputSchema: object({ ...site, entity_id: str, input }, ['site_id', 'entity_id', 'input']),
  },
  { name: 'run_audit', description: 'Queue SEO audit', inputSchema: object(site, ['site_id']) },
  {
    name: 'get_site_performance',
    description: 'Compare site performance with previous period',
    inputSchema: object({ ...site, start: str, end: str }, ['site_id', 'start', 'end']),
  },
  {
    name: 'get_page_performance',
    description: 'Compare page performance',
    inputSchema: object({ ...site, start: str, end: str }, ['site_id', 'start', 'end']),
  },
  {
    name: 'winners',
    description: 'Sites with the highest absolute click gains (minimum volume 10)',
    inputSchema: object({ start: str, end: str }, ['start', 'end']),
  },
  {
    name: 'losers',
    description: 'Sites with the largest click losses (minimum volume 10)',
    inputSchema: object({ start: str, end: str }, ['start', 'end']),
  },
  {
    name: 'create_redirect',
    description: 'Create a redirect, rejecting chains and loops',
    inputSchema: object({ ...site, input }, ['site_id', 'input']),
  },
  {
    name: 'purge_cache',
    description: 'Invalidate only this site',
    inputSchema: object(site, ['site_id']),
  },
];
export async function mcp(request: Request, service: Service) {
  if (request.method !== 'POST')
    return new Response(null, { status: 405, headers: { Allow: 'POST' } });
  if (service.actor.session) fail(403, 'mcp_auth', 'MCP requires a scoped bearer credential');
  service.actor = { ...service.actor, type: 'mcp' };
  const body = (await request.json()) as {
    jsonrpc: string;
    id?: number | string;
    method: string;
    params?: { protocolVersion?: string; name?: string; arguments?: Record<string, any> };
  };
  const response = (value: unknown) =>
    Response.json({ jsonrpc: '2.0', id: body.id ?? null, ...(value as object) });
  if (body.jsonrpc !== '2.0')
    return response({ error: { code: -32600, message: 'Invalid JSON-RPC request' } });
  if (body.id === undefined) {
    if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
    return response({ error: { code: -32600, message: 'Request id required' } });
  }
  if (body.method === 'initialize')
    return response({
      result: {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'penlum', version: '0.1.0' },
        instructions:
          'All content is tenant-scoped. Global code, delete-site and bulk-publish are intentionally unavailable to MCP.',
      },
    });
  if (body.method === 'ping') return response({ result: {} });
  if (body.method === 'tools/list') return response({ result: { tools } });
  if (body.method !== 'tools/call')
    return response({ error: { code: -32601, message: 'Method not found' } });
  const a = body.params?.arguments || {};
  let result: unknown;
  try {
    const name = body.params?.name;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return response({ error: { code: -32602, message: 'Unknown tool' } });
    for (const key of tool.inputSchema.required)
      if (a[key] === undefined) fail(422, 'arguments', `Missing ${key}`);
    switch (name) {
      case 'list_sites':
        result = await service.listSites(100, a.cursor);
        break;
      case 'get_site':
        result = await service.getSite(a.site_id);
        break;
      case 'create_site':
        result = await service.createSite(a.input);
        break;
      case 'update_site':
        result = await service.updateSite(a.site_id, a.input);
        break;
      case 'list_posts':
        result = await service.listPosts(a.site_id, 100, a.cursor);
        break;
      case 'get_post':
        result = await service.getPost(a.site_id, a.post_id);
        break;
      case 'create_post':
        result = await service.createPost(a.site_id, a.input);
        break;
      case 'update_post':
        result = await service.updatePost(a.site_id, a.post_id, a.input);
        break;
      case 'publish_post':
        result = await service.publish(a.site_id, a.post_id, a.input);
        break;
      case 'get_seo':
        result = await service.seo(a.site_id, a.entity_id);
        break;
      case 'update_seo':
        result = await service.seo(a.site_id, a.entity_id, a.input);
        break;
      case 'run_audit':
        result = await service.enqueue('audit', a.site_id);
        break;
      case 'purge_cache':
        result = await service.enqueue('purge', a.site_id);
        break;
      case 'create_redirect':
        result = await service.redirect(a.site_id, a.input);
        break;
      case 'get_site_performance':
      case 'get_page_performance':
        result = await performance(
          service.env,
          service.actor,
          a.start,
          a.end,
          a.site_id,
          name === 'get_page_performance' ? 'pages' : 'sites',
        );
        break;
      case 'winners':
      case 'losers':
        result = (await performance(service.env, service.actor, a.start, a.end))[name];
        break;
      case 'upload_media': {
        if (typeof a.base64 !== 'string' || a.base64.length > 2800000)
          fail(413, 'file_size', 'MCP upload limit is 2 MB');
        const bytes = Uint8Array.from(atob(a.base64), (c) => c.charCodeAt(0));
        result = await upload(
          service,
          a.site_id,
          new File([bytes], a.filename, { type: a.mime }),
          a.alt || '',
        );
        break;
      }
    }
    return response({
      result: { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false },
    });
  } catch (e) {
    return response({
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: e instanceof AppError ? e.code : 'operation_failed',
              message: e instanceof Error ? e.message : 'Operation failed',
            }),
          },
        ],
        isError: true,
      },
    });
  }
}
