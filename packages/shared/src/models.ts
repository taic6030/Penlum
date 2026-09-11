export interface Site {
  id: string;
  name: string;
  primary_domain: string;
  status: 'staging' | 'active' | 'archived';
  locale: string;
  timezone: string;
  theme_id: string;
  site_title: string;
  description: string;
  logo: string | null;
  favicon: string | null;
  default_og: string | null;
  robots_mode: string;
  version: number;
  cache_version: number;
  created_at: string;
  updated_at: string;
}
export interface Post {
  id: string;
  site_id: string;
  type: 'post' | 'page';
  status: 'draft' | 'scheduled' | 'published' | 'archived';
  title: string;
  slug: string;
  excerpt: string;
  markdown_content: string;
  author_id: string;
  featured_media: string | null;
  published_at: string | null;
  scheduled_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}
export interface Actor {
  id: string;
  type: 'user' | 'api' | 'mcp' | 'system';
  superAdmin: boolean;
  siteId?: string;
  scopes: string[];
  session?: boolean;
}
