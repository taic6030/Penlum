import { z } from 'zod';
export const slug = z
  .string()
  .min(1)
  .max(180)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .refine(
    (s) => !['api', 'admin', 'mcp', 'category', 'media', 'robots', 'sitemap'].includes(s),
    'Reserved path',
  );
const text = z.string().max(1000);
export const siteInput = z
  .object({
    name: z.string().min(1).max(120),
    primary_domain: z.string().min(3).max(253),
    site_title: z.string().min(1).max(160),
    description: text.default(''),
    locale: z
      .string()
      .regex(/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .default('vi'),
    timezone: z.string().default('Asia/Ho_Chi_Minh'),
    theme_id: z.enum(['journal', 'editorial', 'minimal']).default('journal'),
  })
  .strict();
export const siteUpdate = siteInput
  .omit({ primary_domain: true })
  .partial()
  .extend({
    version: z.number().int().positive(),
    robots_mode: z.enum(['index', 'noindex']).optional(),
    logo: z.string().nullable().optional(),
    favicon: z.string().nullable().optional(),
    default_og: z.string().nullable().optional(),
  })
  .strict();
export const postInput = z
  .object({
    title: z.string().min(1).max(240),
    slug,
    type: z.enum(['post', 'page']).default('post'),
    excerpt: text.default(''),
    markdown_content: z.string().max(200000).default(''),
    featured_media: z.string().nullable().optional(),
    category_ids: z.array(z.string()).max(30).default([]),
  })
  .strict();
export const postUpdate = postInput
  .partial()
  .extend({ version: z.number().int().positive() })
  .strict();
export const seoInput = z
  .object({
    seo_title: z.string().max(240).nullable().optional(),
    description: text.nullable().optional(),
    canonical_override: z.string().nullable().optional(),
    noindex: z.boolean().default(false),
    nofollow: z.boolean().default(false),
    og_title: text.nullable().optional(),
    og_description: text.nullable().optional(),
    og_image: z.string().nullable().optional(),
    schema_type: z.enum(['BlogPosting', 'Article', 'WebPage']).default('BlogPosting'),
    schema_overrides_json: z.string().default('{}'),
  })
  .strict();
export const targeting = z
  .object({
    kinds: z.array(z.enum(['home', 'posts', 'pages', 'categories', '404'])).optional(),
    include: z.array(z.string().max(200)).max(100).optional(),
    exclude: z.array(z.string().max(200)).max(100).optional(),
  })
  .strict();
export const snippetInput = z
  .object({
    name: z.string().min(1).max(120),
    placement: z.enum([
      'head',
      'body_start',
      'body_end',
      'header_banner',
      'before_content',
      'after_content',
      'sidebar',
      'footer_banner',
    ]),
    targeting: targeting.default({}),
    priority: z.number().int().min(-1000).max(1000).default(0),
    enabled: z.boolean().default(false),
    executable: z.boolean().default(false),
    content: z.string().max(50000),
    version: z.number().int().optional(),
    confirmation: z.literal('APPLY GLOBAL CODE').optional(),
  })
  .strict();
export const redirectInput = z
  .object({
    source_path: z
      .string()
      .min(2)
      .max(500)
      .regex(/^\/(?!\/)[^?#\\]*$/),
    target: z.string().min(1).max(2000),
    status_code: z.union([z.literal(301), z.literal(302)]).default(301),
    enabled: z.boolean().default(true),
  })
  .strict();
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  return schema.parse(value);
}
