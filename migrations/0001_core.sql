PRAGMA foreign_keys = ON;
CREATE TABLE sites (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_domain TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'staging' CHECK(status IN ('staging','active','archived')),
 locale TEXT NOT NULL DEFAULT 'vi', timezone TEXT NOT NULL DEFAULT 'Asia/Ho_Chi_Minh',
 theme_id TEXT NOT NULL DEFAULT 'journal', site_title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 logo TEXT, favicon TEXT, default_og TEXT, robots_mode TEXT NOT NULL DEFAULT 'noindex' CHECK(robots_mode IN ('index','noindex')),
 version INTEGER NOT NULL DEFAULT 1, cache_version INTEGER NOT NULL DEFAULT 1,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE site_domains (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id), hostname TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('primary','alias')), redirect_to_primary INTEGER NOT NULL DEFAULT 1,
 verification_token TEXT NOT NULL, verified_at TEXT, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','verified','disabled'))
);
CREATE INDEX domains_site ON site_domains(site_id);
CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, display_name TEXT NOT NULL,
 password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','super_admin')),
 status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')), last_login TEXT, created_at TEXT NOT NULL);
CREATE TABLE site_memberships (site_id TEXT NOT NULL REFERENCES sites(id), user_id TEXT NOT NULL REFERENCES users(id),
 role TEXT NOT NULL CHECK(role IN ('site_admin','editor','author','analyst','viewer')), PRIMARY KEY(site_id,user_id));
CREATE INDEX memberships_user ON site_memberships(user_id,site_id);
CREATE TABLE sessions (id_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at TEXT NOT NULL);
CREATE INDEX sessions_expiry ON sessions(expires_at);
CREATE TABLE api_credentials (id TEXT PRIMARY KEY,name TEXT NOT NULL,hash TEXT NOT NULL UNIQUE,
 type TEXT NOT NULL CHECK(type IN ('system','site','service')),site_id TEXT REFERENCES sites(id),
 scopes TEXT NOT NULL,expires_at TEXT,status TEXT NOT NULL DEFAULT 'active',last_used TEXT,created_at TEXT NOT NULL);
CREATE INDEX credentials_site ON api_credentials(site_id);
CREATE TABLE posts (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),type TEXT NOT NULL DEFAULT 'post' CHECK(type IN ('post','page')),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','scheduled','published','archived')),
 title TEXT NOT NULL,slug TEXT NOT NULL,excerpt TEXT NOT NULL DEFAULT '',markdown_content TEXT NOT NULL DEFAULT '',
 author_id TEXT NOT NULL,featured_media TEXT,published_at TEXT,scheduled_at TEXT,
 version INTEGER NOT NULL DEFAULT 1,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,deleted_at TEXT,
 PRIMARY KEY(site_id,id),UNIQUE(site_id,slug));
CREATE INDEX posts_status ON posts(site_id,status,published_at,id);
CREATE INDEX posts_schedule ON posts(status,scheduled_at);
CREATE TABLE categories (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),name TEXT NOT NULL,slug TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(site_id,id),UNIQUE(site_id,slug));
CREATE TABLE post_categories (site_id TEXT NOT NULL,post_id TEXT NOT NULL,category_id TEXT NOT NULL,
 PRIMARY KEY(site_id,post_id,category_id),FOREIGN KEY(site_id,post_id) REFERENCES posts(site_id,id),FOREIGN KEY(site_id,category_id) REFERENCES categories(site_id,id));
CREATE TABLE media (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),r2_key TEXT NOT NULL UNIQUE,
 filename TEXT NOT NULL,mime TEXT NOT NULL,width INTEGER NOT NULL,height INTEGER NOT NULL,bytes INTEGER NOT NULL,
 alt TEXT NOT NULL DEFAULT '',title TEXT NOT NULL DEFAULT '',caption TEXT NOT NULL DEFAULT '',checksum TEXT NOT NULL,created_at TEXT NOT NULL,
 PRIMARY KEY(site_id,id));
CREATE TABLE seo_meta (site_id TEXT NOT NULL REFERENCES sites(id),entity_type TEXT NOT NULL CHECK(entity_type IN ('site','post')),entity_id TEXT NOT NULL,
 seo_title TEXT,description TEXT,canonical_override TEXT,noindex INTEGER NOT NULL DEFAULT 0,nofollow INTEGER NOT NULL DEFAULT 0,
 og_title TEXT,og_description TEXT,og_image TEXT,schema_type TEXT NOT NULL DEFAULT 'BlogPosting',schema_overrides_json TEXT NOT NULL DEFAULT '{}',
 PRIMARY KEY(site_id,entity_type,entity_id));
CREATE TABLE redirects (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),source_path TEXT NOT NULL,target TEXT NOT NULL,
 status_code INTEGER NOT NULL DEFAULT 301 CHECK(status_code IN (301,302)),enabled INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(site_id,id),UNIQUE(site_id,source_path));
CREATE TABLE code_snippets (id TEXT PRIMARY KEY,site_id TEXT REFERENCES sites(id),name TEXT NOT NULL,placement TEXT NOT NULL,
 targeting TEXT NOT NULL DEFAULT '{}',priority INTEGER NOT NULL DEFAULT 0,enabled INTEGER NOT NULL DEFAULT 0,
 executable INTEGER NOT NULL DEFAULT 0,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,updated_at TEXT NOT NULL,updated_by TEXT NOT NULL);
CREATE INDEX snippets_site ON code_snippets(site_id,enabled);
CREATE TABLE snippet_revisions (id TEXT PRIMARY KEY,snippet_id TEXT NOT NULL,version INTEGER NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,actor_id TEXT NOT NULL);
CREATE INDEX revisions_snippet ON snippet_revisions(snippet_id,version);
CREATE TABLE theme_settings (site_id TEXT PRIMARY KEY REFERENCES sites(id),settings TEXT NOT NULL DEFAULT '{}');
CREATE TABLE navigation_menus (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),name TEXT NOT NULL,PRIMARY KEY(site_id,id));
CREATE TABLE navigation_items (id TEXT NOT NULL,site_id TEXT NOT NULL,menu_id TEXT NOT NULL,label TEXT NOT NULL,url TEXT NOT NULL,position INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(site_id,id),FOREIGN KEY(site_id,menu_id) REFERENCES navigation_menus(site_id,id));
CREATE TABLE audit_logs (id TEXT PRIMARY KEY,site_id TEXT,actor_type TEXT NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,
 resource TEXT NOT NULL,before_json TEXT,after_json TEXT,request_id TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE INDEX audit_site ON audit_logs(site_id,created_at,id);
CREATE TABLE analytics_daily_site (site_id TEXT NOT NULL REFERENCES sites(id),date TEXT NOT NULL,clicks REAL NOT NULL,impressions REAL NOT NULL,
 position REAL NOT NULL,pageviews INTEGER,sessions INTEGER,PRIMARY KEY(site_id,date));
CREATE TABLE analytics_daily_page (site_id TEXT NOT NULL REFERENCES sites(id),date TEXT NOT NULL,path TEXT NOT NULL,
 clicks REAL NOT NULL,impressions REAL NOT NULL,position REAL NOT NULL,PRIMARY KEY(site_id,date,path));
CREATE TABLE analytics_sync_state (site_id TEXT PRIMARY KEY REFERENCES sites(id),property TEXT,last_sync TEXT,last_date TEXT,error TEXT);
CREATE TABLE seo_audit_results (id TEXT NOT NULL,site_id TEXT NOT NULL REFERENCES sites(id),entity_id TEXT,path TEXT NOT NULL,rule TEXT NOT NULL,
 severity TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'open',details TEXT NOT NULL,detected_at TEXT NOT NULL,resolved_at TEXT,PRIMARY KEY(site_id,id));
CREATE INDEX seo_audit_site ON seo_audit_results(site_id,status);
CREATE TABLE internal_links (site_id TEXT NOT NULL,source_id TEXT NOT NULL,target_path TEXT NOT NULL,
 PRIMARY KEY(site_id,source_id,target_path),FOREIGN KEY(site_id,source_id) REFERENCES posts(site_id,id));
CREATE TABLE idempotency_keys (actor_id TEXT NOT NULL,key TEXT NOT NULL,request_hash TEXT NOT NULL,response TEXT,status INTEGER NOT NULL DEFAULT 0,
 expires_at TEXT NOT NULL,PRIMARY KEY(actor_id,key));
CREATE TABLE rate_limits (key TEXT NOT NULL,window INTEGER NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(key,window));
CREATE TABLE jobs (id TEXT PRIMARY KEY,site_id TEXT,type TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'queued',
 attempts INTEGER NOT NULL DEFAULT 0,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX jobs_status ON jobs(status,created_at);
CREATE TABLE system_state (key TEXT PRIMARY KEY,value TEXT NOT NULL);
INSERT INTO system_state VALUES ('global_cache_version','1');
CREATE TABLE mutation_guards (id TEXT PRIMARY KEY,valid INTEGER NOT NULL CHECK(valid=1));
