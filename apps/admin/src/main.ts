import { icon, iconButton, slugify, publicURL } from './ui';
import type { EditorController } from './editor';
import type { Site, Post } from '../../../packages/shared/src/models';
const root = document.querySelector<HTMLDivElement>('#app')!;
const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
const e = (v: unknown) =>
  String(v ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
let sites: Site[] = [],
  siteId = '',
  me: {
    superAdmin: boolean;
    id: string;
    display_name?: string;
    memberships: { site_id: string; role: string; scopes: string[] }[];
  } | null = null,
  view = 'dashboard',
  generation = 0,
  cleanup = () => {};
let editorController: EditorController | null = null,
  activeHash = '',
  routing = false;
const can = (scope: string) =>
  !!me?.superAdmin ||
  !!me?.memberships?.some((m) => (!siteId || m.site_id === siteId) && m.scopes.includes(scope));
const fmt = (n: number | null | undefined) =>
  n == null ? '—' : new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 }).format(n);
const date = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleDateString('vi-VN') : '—';
const badge = (status: string) =>
  `<span class="badge ${e(status)}">${e(({ active: 'Đang hoạt động', staging: 'Staging', archived: 'Đã lưu trữ', draft: 'Bản nháp', published: 'Đã xuất bản', scheduled: 'Đã lên lịch', verified: 'Đã xác minh', pending: 'Chờ xác minh', completed: 'Hoàn tất', failed: 'Thất bại', queued: 'Đang chờ' } as Record<string, string>)[status] || status)}</span>`;
const diff = (n: { absolute: number; percent: number | null }) =>
  `<span class="${n.absolute >= 0 ? 'positive' : 'negative'}">${n.absolute > 0 ? '+' : ''}${fmt(n.absolute)} <small>${n.percent == null ? 'Kỳ trước bằng 0' : `${n.percent > 0 ? '+' : ''}${fmt(n.percent)}%`}</small></span>`;
function toast(message: string) {
  const el = document.querySelector('#toast')!;
  el.textContent = message;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 4500);
}
async function api(path: string, method = 'GET', data?: unknown): Promise<any> {
  const headers: Record<string, string> = {};
  if (data && !(data instanceof FormData)) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = crypto.randomUUID();
  const response = await fetch('/api/v1' + path, {
    method,
    headers,
    credentials: 'same-origin',
    body: data === undefined ? undefined : data instanceof FormData ? data : JSON.stringify(data),
  });
  const body = await response.json();
  if (!response.ok) {
    if (response.status === 401 && path !== '/auth/login') {
      me = null;
      login();
    }
    const messages: Record<string, string> = {
      version_conflict:
        'Nội dung đã thay đổi ở phiên khác. Rời và mở lại bài để xem bản mới nhất; bản chỉnh sửa của bạn vẫn được giữ trên máy.',
      duplicate: 'Đường dẫn hoặc tên miền này đã tồn tại. Hãy chọn một tên khác.',
      tenant_denied: 'Tài khoản chưa có quyền thực hiện thao tác này trên website.',
      author_denied: 'Bạn chỉ có thể chỉnh sửa bài viết do mình tạo.',
      redirect_collision: 'Đường dẫn đang được dùng cho một chuyển hướng. Hãy chọn đường dẫn khác.',
      rate_limited: 'Bạn đang thao tác quá nhanh. Vui lòng thử lại sau một phút.',
    };
    throw Object.assign(
      new Error(
        messages[body.error?.code] ||
          body.error?.details?.map((x: any) => `${x.path.join('.')}: ${x.message}`).join('\n') ||
          body.error?.message ||
          'Không thể thực hiện yêu cầu',
      ),
      { code: body.error?.code, status: response.status },
    );
  }
  return body.data;
}
async function apiPage(path: string) {
  const response = await fetch('/api/v1' + path, { credentials: 'same-origin' });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Không thể tải dữ liệu');
  return body;
}
const scoped = (path: string) => `/sites/${siteId}${path}`;
const currentSite = () => sites.find((s) => s.id === siteId);
const heading = (title: string, subtitle: string, actions = '') =>
  `<div class="heading"><div><h1>${e(title)}</h1><p>${e(subtitle)}</p></div><div class="actions">${actions}</div></div>`;
const empty = (title: string, text: string, action = '') =>
  `<div class="empty"><div class="empty-symbol">${icon('file-lines')}</div><h3>${e(title)}</h3><p>${e(text)}</p>${action}</div>`;
const panel = (title: string, body: string, action = '') =>
  `<section class="panel"><div class="panel-head"><h2>${e(title)}</h2>${action}</div>${body}</section>`;
const table = (heads: string[], rows: string[]) =>
  `<div class="table-wrap"><table><thead><tr>${heads.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
const button = (text: string, id: string, primary = false) =>
  `<button id="${id}" class="${primary ? 'primary' : ''}">${icon(text.startsWith('+') ? 'plus' : text.includes('Lưu') ? 'floppy-disk' : text.includes('Xuất') ? 'arrow-up-from-bracket' : text.includes('Tìm') ? 'magnifying-glass' : 'arrow-right')}<span>${e(text.replace(/^\+\s*/, ''))}</span></button>`;
const field = (name: string, label: string, value: unknown = '', type = 'text', extra = '') =>
  `<label><span>${e(label)}</span><input name="${name}" type="${type}" value="${e(value)}" ${extra}></label>`;
const textarea = (name: string, label: string, value: unknown = '', rows = 4) =>
  `<label><span>${e(label)}</span><textarea name="${name}" rows="${rows}">${e(value)}</textarea></label>`;
const select = (name: string, label: string, options: [string, string][], value = '') =>
  `<label><span>${e(label)}</span><select name="${name}">${options.map(([v, t]) => `<option value="${e(v)}" ${v === value ? 'selected' : ''}>${e(t)}</option>`).join('')}</select></label>`;
function on(id: string, fn: () => unknown) {
  document.getElementById(id)?.addEventListener('click', () =>
    Promise.resolve()
      .then(fn)
      .catch((err) => toast(err.message)),
  );
}
function modal(
  title: string,
  body: string,
  submit: (form: FormData) => Promise<void>,
  label = 'Lưu',
) {
  dialog.className = '';
  dialog.innerHTML = `<h2>${e(title)}</h2><form>${body}<p class="error-message" role="alert"></p><div class="dialog-footer"><button type="button" id="close-dialog">Hủy</button><button class="primary">${label}</button></div></form>`;
  on('close-dialog', () => dialog.close());
  dialog.querySelector('form')!.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const btn = form.querySelector<HTMLButtonElement>('button.primary')!;
    btn.disabled = true;
    try {
      await submit(new FormData(form));
      dialog.close();
    } catch (err) {
      form.querySelector('.error-message')!.textContent = (err as Error).message;
    } finally {
      btn.disabled = false;
    }
  };
  dialog.showModal();
}
function login() {
  editorController?.destroy();
  editorController = null;
  cleanup();
  root.innerHTML = `<div class="login"><div class="login-card"><div class="logo"><span class="logo-mark">${icon('feather-pointed')}</span>Penlum</div><h1>Chào mừng trở lại</h1><p>Không gian dành cho nội dung của bạn. Đăng nhập để tiếp tục viết và quản lý website.</p><form id="login">${field('email', 'Email', '', 'email', 'required autocomplete="username"')}${field('password', 'Mật khẩu', '', 'password', 'required autocomplete="current-password"')}<p class="error-message" role="alert"></p><button class="primary">Đăng nhập ${icon('arrow-right')}</button><div class="login-foot">${icon('lock')} Bạn chỉ truy cập các website được cấp quyền.</div></form></div></div>`;
  document.querySelector<HTMLFormElement>('#login')!.onsubmit = async (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    const btn = form.querySelector('button')!;
    btn.disabled = true;
    try {
      await api('/auth/login', 'POST', Object.fromEntries(new FormData(form)));
      await boot();
    } catch (err) {
      form.querySelector('.error-message')!.textContent = (err as Error).message;
    } finally {
      btn.disabled = false;
    }
  };
}
const nav: [string, string, string, string][] = [
  ['dashboard', 'house', 'Tổng quan', 'sites:read'],
  ['content', 'file-pen', 'Bài viết', 'content:read'],
  ['pages', 'file-lines', 'Trang', 'content:read'],
  ['media', 'images', 'Thư viện', 'content:read'],
  ['categories', 'folder-open', 'Danh mục', 'content:read'],
  ['seo', 'magnifying-glass-chart', 'SEO', 'seo:read'],
  ['analytics', 'chart-simple', 'Thống kê', 'analytics:read'],
  ['sites', 'globe', 'Websites & cài đặt', 'sites:read'],
  ['users', 'users', 'Thành viên', 'users:read'],
  ['code', 'code', 'Code Manager', 'code:write'],
  ['credentials', 'key', 'API & MCP', 'system:admin'],
  ['system', 'server', 'Hệ thống', 'system:admin'],
];
function shell() {
  const visible = nav.filter((n) => can(n[3]));
  const current = currentSite();
  const role = me?.superAdmin
    ? 'Quản trị hệ thống'
    : me?.memberships?.find((m) => m.site_id === siteId)?.role || 'Thành viên';
  const name = me?.display_name || 'Quản trị viên';
  root.innerHTML = `<div class="layout ${view === 'editor' ? 'editor-shell' : ''}"><aside class="sidebar"><a class="logo" href="#dashboard"><span class="logo-mark">${icon('feather-pointed')}</span>Penlum<span class="logo-tag">CMS</span></a><div class="sidebar-site"><div class="site-avatar">${icon('globe')}</div><div><strong>${e(current?.name || 'Tất cả website')}</strong><small>${e(current?.primary_domain || sites.length + ' website trong hệ thống')}</small></div></div><div class="nav-label">NỘI DUNG & XUẤT BẢN</div><nav aria-label="Điều hướng quản trị">${visible.map(([key, i, label]) => `${key === 'sites' ? '<div class="nav-label">QUẢN TRỊ</div>' : ''}<a href="#${key}" class="${view === key ? 'active' : ''}" ${view === key ? 'aria-current="page"' : ''}>${icon(i)}<span>${label}</span>${key === 'content' ? '<span class="nav-dot"></span>' : ''}</a>`).join('')}</nav><div class="sidebar-bottom">${current ? `<a class="visit-site" href="${e(publicURL(current.primary_domain))}" target="_blank" rel="noopener">${icon('arrow-up-right-from-square')} Xem website ${icon('arrow-right')}</a>` : ''}<div class="sidebar-user"><span class="avatar">${e(name.slice(0, 1))}</span><div><strong>${e(name)}</strong><small>${e(role)}</small></div>${iconButton('arrow-right-from-bracket', 'Đăng xuất', 'logout')}</div></div></aside><div class="workspace"><header class="topbar"><div class="topbar-context">${iconButton('bars', 'Đóng / mở menu', 'mobile-menu')}<span class="breadcrumb">Không gian làm việc <span>/</span> <strong>${e(nav.find((n) => n[0] === view)?.[2] || 'Biên tập')}</strong></span></div><div class="topbar-right"><button class="command-trigger" id="open-command">${icon('magnifying-glass')}<span>Tìm nhanh…</span><kbd>⌘ K</kbd></button><select id="site-switcher" aria-label="Chọn website"><option value="">Tất cả website</option>${sites.map((s) => `<option value="${s.id}" ${s.id === siteId ? 'selected' : ''}>${e(s.name)}</option>`).join('')}</select>${can('content:write') ? `<button class="primary compact" id="quick-create">${icon('plus')} Viết bài</button>` : ''}</div></header><main id="main"><div class="loading"><span class="loading-ring"></span>Đang tải nội dung…</div></main></div></div>`;
  document.querySelector<HTMLSelectElement>('#site-switcher')!.onchange = async (event) => {
    const selector = event.target as HTMLSelectElement;
    const next = selector.value;
    if (editorController && !(await editorController.beforeLeave())) {
      selector.value = siteId;
      return;
    }
    editorController?.destroy();
    editorController = null;
    siteId = next;
    sessionStorage.setItem('penlum_site', siteId);
    if (view === 'editor') location.hash = 'content';
    else void route();
  };
  on('mobile-menu', () => root.querySelector('.layout')?.classList.toggle('menu-open'));
  on('quick-create', newPost);
  on('open-command', commandPalette);
  on('logout', async () => {
    if (editorController && !(await editorController.beforeLeave())) return;
    editorController?.destroy();
    editorController = null;
    await api('/auth/logout', 'POST', {});
    me = null;
    login();
  });
}
function newPost() {
  if (siteId) {
    location.hash = 'editor/new';
    return;
  }
  if (sites.length === 1) {
    siteId = sites[0].id;
    sessionStorage.setItem('penlum_site', siteId);
    location.hash = 'editor/new';
    return;
  }
  modal(
    'Viết bài cho website nào?',
    select(
      'site',
      'Website',
      sites
        .filter(
          (s) =>
            me?.superAdmin ||
            me?.memberships?.some((m) => m.site_id === s.id && m.scopes.includes('content:write')),
        )
        .map((s) => [s.id, s.name]),
    ),
    async (f) => {
      siteId = String(f.get('site'));
      sessionStorage.setItem('penlum_site', siteId);
      location.hash = 'editor/new';
    },
    'Bắt đầu viết',
  );
}
function commandPalette() {
  dialog.className = 'command-dialog';
  dialog.innerHTML = `<div class="command-search">${icon('magnifying-glass')}<input id="command-input" placeholder="Tìm màn hình hoặc website…" aria-label="Tìm nhanh"><button id="close-command" class="text-button">Esc</button></div><div id="command-results"></div>`;
  const items = [
    ...nav
      .filter((n) => can(n[3]))
      .map(([key, i, label]) => ({
        label,
        icon: i,
        run: () => {
          location.hash = key;
        },
      })),
    ...sites.map((s) => ({
      label: s.name + ' · ' + s.primary_domain,
      icon: 'globe',
      run: () => {
        siteId = s.id;
        sessionStorage.setItem('penlum_site', siteId);
        location.hash = 'content';
        void route();
      },
    })),
  ];
  const input = dialog.querySelector<HTMLInputElement>('input')!;
  const paint = () => {
    const matches = items.filter((x) => x.label.toLowerCase().includes(input.value.toLowerCase()));
    dialog.querySelector('#command-results')!.innerHTML =
      matches
        .map(
          (item, i) =>
            `<button data-command="${i}">${icon(item.icon)}${e(item.label)}${icon('arrow-turn-down')}</button>`,
        )
        .join('') || '<p class="muted">Không tìm thấy kết quả.</p>';
    dialog.querySelectorAll<HTMLElement>('[data-command]').forEach(
      (btn) =>
        (btn.onclick = () => {
          dialog.close();
          matches[Number(btn.dataset.command)].run();
        }),
    );
  };
  input.oninput = paint;
  input.onkeydown = (event) => {
    if (event.key === 'Enter') dialog.querySelector<HTMLButtonElement>('[data-command]')?.click();
  };
  dialog.querySelector('#close-command')!.addEventListener('click', () => dialog.close());
  paint();
  dialog.showModal();
  input.focus();
}
function needSite(main: HTMLElement) {
  if (siteId) return false;
  main.innerHTML =
    heading(
      nav.find((n) => n[0] === view)?.[2] || 'Website',
      'Chọn website để làm việc với dữ liệu riêng của website đó.',
    ) +
    panel(
      'Chọn website',
      empty(
        'Bạn đang ở chế độ tổng hợp',
        'Chọn một website từ menu phía trên hoặc mở danh sách website.',
        '<a href="#sites">Mở danh sách website →</a>',
      ),
    );
  return true;
}
async function refreshSites() {
  let cursor = '';
  sites = [];
  do {
    const result = await apiPage(
      '/sites?limit=100' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : ''),
    );
    sites.push(...result.data);
    cursor = result.next_cursor || '';
  } while (cursor);
}
async function boot() {
  me = await api('/auth/me');
  await refreshSites();
  siteId = sessionStorage.getItem('penlum_site') || '';
  if (!sites.some((s) => s.id === siteId)) siteId = sites.length === 1 ? sites[0].id : '';
  sessionStorage.setItem('penlum_site', siteId);
  await route();
}
function filterActions(main: HTMLElement) {
  const rules: [boolean, string][] = [
    [!!me?.superAdmin, '#create-site,#apply-bulk,#export-site,#add-user'],
    [
      can('sites:write'),
      '#edit-site,#toggle-site,#add-domain,#edit-menu,#edit-theme,#purge-site,[data-domain]',
    ],
    [can('media:write'), '#upload-media,[data-edit-media]'],
  ];
  for (const [allowed, selectors] of rules)
    if (!allowed) main.querySelectorAll(selectors).forEach((el) => el.remove());
}
async function route() {
  if (routing) return;
  const requested = location.hash;
  if (editorController) {
    routing = true;
    const leave = await editorController.beforeLeave();
    routing = false;
    if (!leave) {
      history.replaceState(null, '', activeHash || '#content');
      return;
    }
    editorController.destroy();
    editorController = null;
  }
  activeHash = requested;
  cleanup();
  cleanup = () => {};
  const ticket = ++generation;
  view = location.hash.slice(1).split('/')[0] || 'dashboard';
  if (view !== 'editor' && !can(nav.find((n) => n[0] === view)?.[3] || 'sites:read'))
    view = 'dashboard';
  shell();
  const main = document.querySelector<HTMLElement>('#main')!;
  try {
    if (view === 'editor') {
      await editor(main, location.hash.split('/')[1]?.split('?')[0]);
      return;
    }
    if (['seo', 'media', 'categories'].includes(view) && needSite(main)) return;
    const handlers: Record<string, (main: HTMLElement) => Promise<void>> = {
      dashboard,
      sites: sitesView,
      content: contentView,
      pages: contentView,
      categories: categoriesView,
      seo: seoView,
      analytics: analyticsView,
      media: mediaView,
      users: usersView,
      code: codeView,
      credentials: credentialsView,
      system: systemView,
    };
    await (handlers[view] || dashboard)(main);
    filterActions(main);
  } catch (err) {
    if (ticket === generation && me)
      main.innerHTML =
        heading('Không thể tải nội dung', (err as Error).message) + button('Thử lại', 'retry');
    on('retry', route);
  }
}
async function dashboard(main: HTMLElement) {
  const current = currentSite();
  const posts = siteId && can('content:read') ? await loadSitePosts(siteId) : [];
  if (!main.isConnected) return;
  const drafts = posts.filter((p) => p.status === 'draft'),
    published = posts.filter((p) => p.status === 'published'),
    scheduled = posts.filter((p) => p.status === 'scheduled');
  const recent = [...posts].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 5);
  main.innerHTML =
    heading(
      current ? 'Không gian của bạn' : 'Tổng quan hệ thống',
      current
        ? current.name + ' · ' + current.primary_domain
        : `${sites.length} website trong một không gian quản trị`,
      current
        ? `<a class="visit-link" href="${e(publicURL(current.primary_domain))}" target="_blank" rel="noopener">${icon('arrow-up-right-from-square')} Xem website</a>`
        : me?.superAdmin
          ? button('+ Tạo website', 'create-site', true)
          : '',
    ) +
    `<section class="welcome-card"><div><div class="eyebrow">VIẾT · BIÊN TẬP · XUẤT BẢN</div><h2>Câu chuyện tiếp theo của bạn là gì?</h2><p>${current ? 'Mở một trang viết mới hoặc tiếp tục bản nháp còn dang dở. Mọi nội dung, hình ảnh và cài đặt nằm ngay trong không gian website này.' : 'Chọn website để bắt đầu viết và quản lý nội dung của từng thương hiệu.'}</p><div class="actions">${can('content:write') ? `<button class="primary" id="dashboard-write">${icon('pen-nib')} Bắt đầu viết</button>` : ''}<a href="#content">Xem nội dung ${icon('arrow-right')}</a></div></div><div class="welcome-art" aria-hidden="true">${icon('feather-pointed')}</div></section>` +
    (current
      ? `<div class="metrics">${[
          ['file-lines', 'Tổng nội dung', posts.length, 'Bài viết và trang'],
          ['circle-check', 'Đã xuất bản', published.length, 'Đang hiển thị trên website'],
          ['file-pen', 'Bản nháp', drafts.length, 'Sẵn sàng để viết tiếp'],
          ['calendar-days', 'Đã lên lịch', scheduled.length, 'Chờ thời điểm xuất bản'],
        ]
          .map(
            ([i, label, n, sub]) =>
              `<div class="metric"><span>${icon(String(i))}${label}</span><strong>${n}</strong><small>${sub}</small></div>`,
          )
          .join(
            '',
          )}</div><div class="split">${panel('Chỉnh sửa gần đây', recent.length ? recent.map((p) => `<div class="recent-item"><span class="post-type-icon">${icon(p.type === 'page' ? 'file-lines' : 'file-pen')}</span><div><a href="#editor/${p.id}"><strong>${e(p.title)}</strong></a><small>Cập nhật ${date(p.updated_at)}</small></div>${badge(p.status)}<a href="#editor/${p.id}" aria-label="Mở ${e(p.title)}">${icon('arrow-right')}</a></div>`).join('') : empty('Một khởi đầu mới', 'Bài viết đầu tiên sẽ xuất hiện ở đây.'), '<a href="#content">Tất cả nội dung →</a>')}${panel(
          'Trong website này',
          `<div class="quick-links">${[
            ['media', 'images', 'Thư viện hình ảnh', 'Tải lên và tái sử dụng ảnh', 'content:read'],
            [
              'categories',
              'folder-open',
              'Sắp xếp danh mục',
              'Nhóm nội dung để dễ tìm hơn',
              'content:read',
            ],
            [
              'seo',
              'magnifying-glass-chart',
              'Tối ưu tìm kiếm',
              'Kiểm tra và cấu hình SEO',
              'seo:read',
            ],
            ['sites', 'sliders', 'Cài đặt website', 'Giao diện, menu và tên miền', 'sites:read'],
          ]
            .filter((x) => can(x[4]))
            .map(
              ([href, i, label, sub]) =>
                `<a href="#${href}">${icon(i)}<span><strong>${label}</strong><small>${sub}</small></span>${icon('chevron-right')}</a>`,
            )
            .join('')}</div>`,
        )}</div>`
      : `<div class="metrics"><div class="metric"><span>${icon('globe')} Websites</span><strong>${sites.length}</strong><small>Trong phạm vi được cấp quyền</small></div><div class="metric"><span>${icon('circle-check')} Đang hoạt động</span><strong>${sites.filter((s) => s.status === 'active').length}</strong><small>Sẵn sàng phục vụ người đọc</small></div></div>` +
        panel(
          'Websites của bạn',
          sites.length
            ? siteTable(sites)
            : empty('Chưa có website', 'Tạo website đầu tiên để bắt đầu.'),
          '<a href="#sites">Quản lý websites →</a>',
        ));
  on('dashboard-write', newPost);
  on('create-site', createSite);
  bindSiteActions();
}
function siteTable(list: Site[]) {
  return table(
    ['', 'Website', 'Trạng thái', 'Theme', 'Cập nhật', ''],
    list.map(
      (s) =>
        `<tr><td><input type="checkbox" class="site-check" value="${s.id}" aria-label="Chọn ${e(s.name)}"></td><td><strong>${e(s.name)}</strong><small>${e(s.primary_domain)}</small></td><td>${badge(s.status)}</td><td>${e(s.theme_id)}</td><td>${date(s.updated_at)}</td><td><button data-open-site="${s.id}">Quản lý →</button></td></tr>`,
    ),
  );
}
function bindSiteActions() {
  document.querySelectorAll<HTMLElement>('[data-open-site]').forEach(
    (el) =>
      (el.onclick = () => {
        siteId = el.dataset.openSite!;
        sessionStorage.setItem('penlum_site', siteId);
        location.hash = 'sites';
        void route();
      }),
  );
}
async function createSite() {
  modal(
    'Tạo website',
    field('name', 'Tên website', '', 'text', 'required') +
      field('primary_domain', 'Tên miền chính', '', 'text', 'required placeholder="example.com"') +
      field('site_title', 'Tiêu đề website', '', 'text', 'required') +
      textarea('description', 'Mô tả') +
      select('theme_id', 'Theme', [
        ['journal', 'Journal · Tập trung bài viết'],
        ['editorial', 'Editorial · Tạp chí'],
        ['minimal', 'Minimal · Tối giản'],
      ]),
    async (form) => {
      const site = await api('/sites', 'POST', Object.fromEntries(form));
      siteId = site.id;
      sessionStorage.setItem('penlum_site', siteId);
      await refreshSites();
      location.hash = 'sites';
      await route();
      toast('Website được tạo ở trạng thái staging.');
    },
    'Tạo website',
  );
}
async function sitesView(main: HTMLElement) {
  if (!siteId) {
    main.innerHTML =
      heading(
        'Websites',
        `${sites.length} website · Một codebase, nhiều thương hiệu độc lập`,
        button('+ Tạo website', 'create-site', true),
      ) +
      `<div class="toolbar"><input type="search" id="search-sites" aria-label="Tìm website" placeholder="Tìm theo tên hoặc tên miền…"><select id="status-sites" aria-label="Lọc trạng thái"><option value="">Tất cả trạng thái</option><option value="active">Đang hoạt động</option><option value="staging">Staging</option><option value="archived">Đã lưu trữ</option></select></div><div class="toolbar"><select id="bulk-action" aria-label="Thao tác hàng loạt"><option value="audit">SEO audit</option><option value="purge">Xóa cache</option><option value="activate">Kích hoạt</option><option value="archive">Lưu trữ</option><option value="export">Export (R2)</option></select><button id="apply-bulk">Áp dụng cho website đã chọn</button></div><section class="panel" id="sites-table">${sites.length ? siteTable(sites) : empty('Chưa có website', 'Tạo website đầu tiên để bắt đầu quản lý nội dung.')}</section>`;
    const filter = () => {
      const query = (
        document.querySelector('#search-sites') as HTMLInputElement
      ).value.toLowerCase();
      const status = (document.querySelector('#status-sites') as HTMLSelectElement).value;
      document.querySelector('#sites-table')!.innerHTML = siteTable(
        sites.filter(
          (s) =>
            (!status || s.status === status) &&
            (s.name + ' ' + s.primary_domain).toLowerCase().includes(query),
        ),
      );
      bindSiteActions();
    };
    document.querySelector('#search-sites')!.addEventListener('input', filter);
    document.querySelector('#status-sites')!.addEventListener('change', filter);
    on('create-site', createSite);
    on('apply-bulk', () => {
      const selected = Array.from(
        document.querySelectorAll<HTMLInputElement>('.site-check:checked'),
      ).map((el) => el.value);
      if (!selected.length) throw new Error('Chọn ít nhất một website.');
      const action = (document.querySelector('#bulk-action') as HTMLSelectElement).value;
      modal(
        'Thao tác hàng loạt',
        `<p>Áp dụng ${e(action)} cho ${selected.length} website đã chọn.</p>`,
        async () => {
          const results = await api('/sites/bulk', 'POST', { site_ids: selected, action });
          await refreshSites();
          await route();
          toast(`${results.filter((r: any) => r.ok).length}/${results.length} website thành công.`);
          if (results.some((r: any) => !r.ok))
            download(JSON.stringify(results, null, 2), 'penlum-bulk-results.json');
        },
        'Áp dụng',
      );
    });
    bindSiteActions();
    return;
  }
  const s = currentSite()!,
    domains = await api(scoped('/domains'));
  main.innerHTML =
    heading(
      s.name,
      s.primary_domain,
      button('Cấu hình', 'edit-site') +
        button('Xuất dữ liệu', 'export-site') +
        button(s.status === 'active' ? 'Lưu trữ' : 'Kích hoạt', 'toggle-site', true),
    ) +
    `<div class="split">${panel('Cấu hình website', `<div class="panel-body"><ul class="checklist"><li><span>Trạng thái</span>${badge(s.status)}</li><li><span>Theme</span><strong>${e(s.theme_id)}</strong></li><li><span>Robots</span><strong>${e(s.robots_mode)}</strong></li><li><span>Ngôn ngữ / Múi giờ</span><span>${e(s.locale)} / ${e(s.timezone)}</span></li></ul><div class="actions"><a href="#content">Quản lý nội dung →</a><a href="#seo">Cấu hình SEO →</a></div></div>`)}${panel(
      'Tên miền',
      table(
        ['Hostname', 'Xác minh', ''],
        domains.map(
          (d: any) =>
            `<tr><td><strong>${e(d.hostname)}</strong><small>${e(d.type)}</small></td><td>${badge(d.status)}</td><td><button data-domain="${d.id}">Kiểm tra</button></td></tr>`,
        ),
      ),
      button('+ Alias', 'add-domain'),
    )}</div>` +
    panel(
      'Điều hướng & hiển thị',
      `<div class="panel-body actions">${button('Sửa menu chính', 'edit-menu')}${button('Tùy chỉnh theme', 'edit-theme')}${button('Xóa cache website', 'purge-site')}</div>`,
    );
  on('toggle-site', async () => {
    modal(
      s.status === 'active' ? 'Lưu trữ website?' : 'Kích hoạt website?',
      `<p>${s.status === 'active' ? 'Website sẽ ngừng phục vụ public, nội dung được giữ lại.' : 'Tên miền chính cần được xác minh. Chế độ robots vẫn theo cấu hình của bạn.'}</p>`,
      async () => {
        await api(scoped(s.status === 'active' ? '/archive' : '/activate'), 'POST', {});
        await refreshSites();
        await route();
      },
      'Xác nhận',
    );
  });
  on('edit-site', () =>
    modal(
      'Cấu hình website',
      field('name', 'Tên website', s.name) +
        field('site_title', 'Tiêu đề', s.site_title) +
        textarea('description', 'Mô tả', s.description) +
        select(
          'theme_id',
          'Theme',
          [
            ['journal', 'Journal'],
            ['editorial', 'Editorial'],
            ['minimal', 'Minimal'],
          ],
          s.theme_id,
        ) +
        select(
          'robots_mode',
          'Cho phép index',
          [
            ['noindex', 'Noindex · Chưa cho index'],
            ['index', 'Index · Cho phép index'],
          ],
          s.robots_mode,
        ) +
        field('logo', 'URL logo', s.logo) +
        field('favicon', 'URL favicon', s.favicon) +
        field('default_og', 'URL ảnh chia sẻ mặc định', s.default_og),
      async (f) => {
        const data = Object.fromEntries(f);
        await api(scoped(''), 'PATCH', {
          ...data,
          logo: data.logo || null,
          favicon: data.favicon || null,
          default_og: data.default_og || null,
          version: s.version,
        });
        await refreshSites();
        await route();
      },
    ),
  );
  on('add-domain', () =>
    modal('Thêm alias', field('hostname', 'Hostname', '', 'text', 'required'), async (f) => {
      await api(scoped('/domains'), 'POST', Object.fromEntries(f));
      await route();
    }),
  );
  document.querySelectorAll<HTMLElement>('[data-domain]').forEach(
    (el) =>
      (el.onclick = () => {
        const d = domains.find((x: any) => x.id === el.dataset.domain);
        modal(
          'Xác minh tên miền',
          `<p>Tạo bản ghi TXT sau tại nhà cung cấp DNS.</p><pre>${e('_penlum.' + d.hostname)}\n${e('penlum-verification=' + d.verification_token)}</pre><p class="hint">Domain .localhost được xác minh trực tiếp trong môi trường development.</p>`,
          async () => {
            await api(scoped(`/domains/${d.id}/verify`), 'POST', {});
            await route();
          },
          'Kiểm tra DNS',
        );
      }),
  );
  on('export-site', async () => {
    const data = await api(scoped('/export'));
    download(JSON.stringify(data, null, 2), `${s.primary_domain}-export.json`);
    toast('Đã xuất nội dung và media manifest.');
  });
  on('purge-site', async () => {
    await api(scoped('/purge'), 'POST', {});
    toast('Đã đổi phiên bản cache riêng của website.');
  });
  on('edit-menu', async () => {
    const items = await api(scoped('/navigation_items'));
    modal(
      'Menu chính',
      textarea(
        'items',
        'Mỗi dòng: Nhãn | /duong-dan',
        items.map((n: any) => n.label + ' | ' + n.url).join('\n'),
        8,
      ),
      async (f) => {
        const data = String(f.get('items'))
          .split('\n')
          .filter(Boolean)
          .map((line) => {
            const [label, url] = line.split('|');
            return { label: label.trim(), url: url?.trim() };
          });
        await api(scoped('/navigation'), 'PUT', data);
        toast('Đã lưu menu.');
      },
    );
  });
  on('edit-theme', () =>
    modal(
      'Tùy chỉnh theme',
      select('container', 'Chiều rộng', [
        ['narrow', 'Hẹp · 680px'],
        ['wide', 'Rộng · 960px'],
      ]) +
        select('typography', 'Chữ', [
          ['serif', 'Serif'],
          ['sans', 'Sans serif'],
        ]),
      async (f) => {
        await api(scoped('/theme'), 'PUT', Object.fromEntries(f));
        toast('Đã lưu theme.');
      },
    ),
  );
}
function download(text: string, name: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function loadSitePosts(sid: string): Promise<Post[]> {
  let cursor = '';
  const rows: Post[] = [];
  do {
    const result = await apiPage(
      `${sid ? '/sites/' + sid + '/posts' : '/content'}?limit=100&cursor=${encodeURIComponent(cursor)}`,
    );
    rows.push(...result.data);
    cursor = result.next_cursor || '';
  } while (cursor);
  return rows;
}
async function contentView(main: HTMLElement) {
  const pageType = view === 'pages' ? 'page' : 'post',
    title = pageType === 'page' ? 'Trang' : 'Bài viết';
  let rows: (Post & { site_name?: string })[] = await loadSitePosts(siteId);
  if (!main.isConnected) return;
  let activeStatus = '',
    query = '',
    sort = 'updated',
    pageNumber = 1;
  const selected = new Set<string>();
  main.innerHTML =
    heading(
      title,
      siteId
        ? `Quản lý nội dung của ${currentSite()!.name}`
        : 'Tìm và quản lý nội dung trên các website được cấp quyền.',
      can('content:write')
        ? `<button id="new-post" class="primary">${icon('plus')} ${pageType === 'page' ? 'Thêm trang' : 'Viết bài mới'}</button>`
        : '',
    ) +
    `<section class="content-library"><div class="content-tabs" role="tablist" aria-label="Trạng thái nội dung">${[
      ['', 'Tất cả'],
      ['published', 'Đã xuất bản'],
      ['draft', 'Bản nháp'],
      ['scheduled', 'Đã lên lịch'],
    ]
      .map(
        ([status, label]) =>
          `<button class="${!status ? 'active' : ''}" role="tab" aria-selected="${!status}" data-content-status="${status}">${label}<span>${rows.filter((p) => p.type === pageType && (!status || p.status === status)).length}</span></button>`,
      )
      .join(
        '',
      )}</div><div class="content-filters"><label class="search-field">${icon('magnifying-glass')}<input id="search-posts" type="search" placeholder="Tìm theo tiêu đề hoặc đường dẫn…" aria-label="Tìm nội dung"></label><div class="actions"><label class="sort-label">${icon('arrow-down-wide-short')}<select id="post-sort" aria-label="Sắp xếp nội dung"><option value="updated">Cập nhật gần nhất</option><option value="title">Tiêu đề A–Z</option><option value="published">Xuất bản gần nhất</option></select></label><button id="refresh-posts" class="icon-button" title="Làm mới" aria-label="Làm mới nội dung">${icon('arrows-rotate')}</button></div></div><div id="content-bulk" class="content-bulk" hidden><strong id="selected-count"></strong>${can('content:publish') && siteId ? '<button id="bulk-draft">Chuyển về bản nháp</button>' : ''}${can('content:write') && siteId ? '<button id="bulk-trash" class="danger">Lưu trữ đã chọn</button>' : ''}<button id="clear-selection" class="text-button">Bỏ chọn</button></div><div id="posts-list"></div><div class="content-pagination"><span id="list-range"></span><div class="actions"><button id="prev-posts" class="icon-button" aria-label="Trang trước">${icon('chevron-left')}</button><span id="page-label"></span><button id="next-posts" class="icon-button" aria-label="Trang tiếp">${icon('chevron-right')}</button></div></div></section>`;
  const updateBulk = () => {
    const bulk = main.querySelector<HTMLElement>('#content-bulk')!;
    bulk.hidden = !selected.size;
    main.querySelector('#selected-count')!.textContent =
      `Đã chọn ${selected.size} ${pageType === 'page' ? 'trang' : 'bài viết'}`;
  };
  const paint = () => {
    let visible = rows.filter(
      (p) =>
        p.type === pageType &&
        (!activeStatus || p.status === activeStatus) &&
        (p.title + ' ' + p.slug).toLowerCase().includes(query),
    );
    visible.sort((a, b) =>
      sort === 'title'
        ? a.title.localeCompare(b.title, 'vi')
        : sort === 'published'
          ? (b.published_at || '').localeCompare(a.published_at || '')
          : b.updated_at.localeCompare(a.updated_at),
    );
    const pages = Math.max(1, Math.ceil(visible.length / 15));
    pageNumber = Math.min(pageNumber, pages);
    const slice = visible.slice((pageNumber - 1) * 15, pageNumber * 15);
    main.querySelector('#posts-list')!.innerHTML = visible.length
      ? `<div class="table-wrap"><table class="posts-table"><thead><tr><th class="checkbox-cell"><input id="select-page" type="checkbox" aria-label="Chọn tất cả nội dung trên trang"></th><th>TIÊU ĐỀ</th>${!siteId ? '<th>WEBSITE</th>' : ''}<th>TRẠNG THÁI</th><th>CẬP NHẬT</th><th class="row-action-head">THAO TÁC</th></tr></thead><tbody>${slice
          .map((p) => {
            const site = sites.find((s) => s.id === p.site_id);
            return `<tr class="${selected.has(p.id) ? 'is-selected' : ''}"><td class="checkbox-cell"><input type="checkbox" data-select-post="${p.id}" ${selected.has(p.id) ? 'checked' : ''} aria-label="Chọn ${e(p.title)}"></td><td class="post-title-cell"><div class="post-cell"><span class="post-type-icon ${p.status}">${icon(p.type === 'page' ? 'file-lines' : 'file-pen')}</span><div><a class="post-title-link" href="#editor/${p.id}" data-edit-post="${p.id}" data-site="${p.site_id}">${e(p.title)}</a><small>/${e(p.slug)}</small></div></div></td>${!siteId ? `<td data-column="site">${e(p.site_name || site?.name)}</td>` : ''}<td data-column="status">${badge(p.status)}</td><td data-column="updated"><span>${date(p.updated_at)}</span><small>${new Date(p.updated_at).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}</small></td><td data-column="actions"><div class="row-actions"><button class="icon-button" data-edit-post="${p.id}" data-site="${p.site_id}" aria-label="${can('content:write') ? 'Sửa' : 'Xem'} ${e(p.title)}" title="${can('content:write') ? 'Chỉnh sửa' : 'Xem nội dung'}">${icon(can('content:write') ? 'pen-to-square' : 'eye')}</button>${p.status === 'published' && site ? `<a class="icon-button" href="${e(publicURL(site.primary_domain, '/' + p.slug))}" target="_blank" rel="noopener" title="Xem trên website" aria-label="Xem ${e(p.title)} trên website">${icon('arrow-up-right-from-square')}</a>` : ''}${can('content:write') && siteId ? `<button class="icon-button" data-duplicate="${p.id}" title="Nhân bản thành bản nháp" aria-label="Nhân bản ${e(p.title)}">${icon('copy')}</button><button class="icon-button danger" data-trash="${p.id}" title="Lưu trữ nội dung" aria-label="Lưu trữ ${e(p.title)}">${icon('box-archive')}</button>` : ''}</div></td></tr>`;
          })
          .join('')}</tbody></table></div>`
      : empty(
          query
            ? 'Không tìm thấy nội dung'
            : activeStatus
              ? 'Chưa có nội dung ở trạng thái này'
              : 'Câu chuyện tiếp theo bắt đầu từ đây',
          query
            ? 'Thử từ khóa ngắn hơn hoặc chọn trạng thái khác.'
            : 'Mở trình soạn thảo, viết điều bạn muốn chia sẻ và xem trước trước khi xuất bản.',
          can('content:write') && !query
            ? '<button class="primary" id="empty-new-post">' +
                icon('plus') +
                ' Bắt đầu viết</button>'
            : '',
        );
    main.querySelector('#list-range')!.textContent = visible.length
      ? `${(pageNumber - 1) * 15 + 1}–${Math.min(pageNumber * 15, visible.length)} / ${visible.length} ${pageType === 'page' ? 'trang' : 'bài viết'}`
      : '0 nội dung';
    main.querySelector('#page-label')!.textContent = `Trang ${pageNumber} / ${pages}`;
    (main.querySelector('#prev-posts') as HTMLButtonElement).disabled = pageNumber === 1;
    (main.querySelector('#next-posts') as HTMLButtonElement).disabled = pageNumber === pages;
    main.querySelectorAll<HTMLElement>('[data-edit-post]').forEach(
      (btn) =>
        (btn.onclick = (event) => {
          event.preventDefault();
          siteId = btn.dataset.site!;
          sessionStorage.setItem('penlum_site', siteId);
          location.hash = 'editor/' + btn.dataset.editPost;
        }),
    );
    main.querySelectorAll<HTMLInputElement>('[data-select-post]').forEach(
      (input) =>
        (input.onchange = () => {
          input.checked
            ? selected.add(input.dataset.selectPost!)
            : selected.delete(input.dataset.selectPost!);
          updateBulk();
        }),
    );
    const all = main.querySelector<HTMLInputElement>('#select-page');
    if (all) {
      all.checked = !!slice.length && slice.every((p) => selected.has(p.id));
      all.onchange = () => {
        slice.forEach((p) => (all.checked ? selected.add(p.id) : selected.delete(p.id)));
        paint();
        updateBulk();
      };
    }
    main.querySelectorAll<HTMLElement>('[data-duplicate]').forEach(
      (btn) =>
        (btn.onclick = () =>
          void (async () => {
            const source: any = await api(`/sites/${siteId}/posts/${btn.dataset.duplicate}`);
            const created = await api(`/sites/${siteId}/posts`, 'POST', {
              title: source.title + ' (bản sao)',
              slug: source.slug.slice(0, 145) + '-copy-' + crypto.randomUUID().slice(0, 6),
              type: source.type,
              markdown_content: source.markdown_content,
              excerpt: source.excerpt,
              featured_media: source.featured_media,
              category_ids: source.category_ids,
            });
            location.hash = 'editor/' + created.id;
            toast('Đã tạo bản sao ở trạng thái nháp.');
          })().catch((err) => toast(err.message))),
    );
    main
      .querySelectorAll<HTMLElement>('[data-trash]')
      .forEach((btn) => (btn.onclick = () => archive([btn.dataset.trash!])));
    on('empty-new-post', () => {
      if (siteId) location.hash = 'editor/new' + (pageType === 'page' ? '?type=page' : '');
      else newPost();
    });
  };
  const archive = (ids: string[]) =>
    modal(
      'Lưu trữ nội dung?',
      `<p>${ids.length} nội dung sẽ được ẩn khỏi website và danh sách đang làm việc. Dữ liệu vẫn được giữ trong hệ thống.</p>`,
      async () => {
        for (const id of ids) await api(scoped('/posts/' + id), 'DELETE');
        toast('Đã lưu trữ nội dung.');
        await route();
      },
      'Lưu trữ',
    );
  main.querySelectorAll<HTMLElement>('[data-content-status]').forEach(
    (btn) =>
      (btn.onclick = () => {
        activeStatus = btn.dataset.contentStatus!;
        pageNumber = 1;
        main.querySelectorAll('[data-content-status]').forEach((b) => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
        paint();
      }),
  );
  main.querySelector<HTMLInputElement>('#search-posts')!.oninput = (event) => {
    query = (event.target as HTMLInputElement).value.toLowerCase();
    pageNumber = 1;
    paint();
  };
  main.querySelector<HTMLSelectElement>('#post-sort')!.onchange = (event) => {
    sort = (event.target as HTMLSelectElement).value;
    paint();
  };
  on('refresh-posts', route);
  on('prev-posts', () => {
    pageNumber--;
    paint();
  });
  on('next-posts', () => {
    pageNumber++;
    paint();
  });
  on('clear-selection', () => {
    selected.clear();
    paint();
    updateBulk();
  });
  on('bulk-trash', () => archive([...selected]));
  on('bulk-draft', () =>
    modal(
      'Chuyển về bản nháp?',
      `<p>${selected.size} nội dung sẽ ngừng hiển thị công khai.</p>`,
      async () => {
        for (const id of selected) await api(scoped('/posts/' + id + '/unpublish'), 'POST', {});
        await route();
      },
      'Chuyển bản nháp',
    ),
  );
  on('new-post', () => {
    if (siteId) location.hash = 'editor/new' + (pageType === 'page' ? '?type=page' : '');
    else newPost();
  });
  paint();
}
async function categoriesView(main: HTMLElement) {
  const rows: any[] = await api(scoped('/categories?limit=100'));
  main.innerHTML =
    heading(
      'Danh mục',
      `Sắp xếp nội dung của ${currentSite()!.name} thành những chủ đề rõ ràng.`,
      can('content:write')
        ? `<button id="new-category-main" class="primary">${icon('plus')} Thêm danh mục</button>`
        : '',
    ) +
    panel(
      'Các chủ đề',
      rows.length
        ? table(
            ['Tên danh mục', 'Đường dẫn', 'Mô tả', ''],
            rows.map(
              (c) =>
                `<tr><td><strong>${icon('folder')} ${e(c.name)}</strong></td><td>/category/${e(c.slug)}</td><td>${e(c.description || '—')}</td><td>${can('content:write') ? `<div class="row-actions"><button class="icon-button" data-edit-category="${c.id}" aria-label="Sửa ${e(c.name)}">${icon('pen')}</button><button class="icon-button danger" data-delete-category="${c.id}" aria-label="Xóa ${e(c.name)}">${icon('trash-can')}</button></div>` : ''}</td></tr>`,
            ),
          )
        : empty(
            'Nhóm những câu chuyện cùng chủ đề',
            'Thêm danh mục như Cẩm nang, Tin tức hoặc Chia sẻ.',
          ),
    );
  const edit = (c: any = {}) =>
    modal(
      c.id ? 'Chỉnh sửa danh mục' : 'Thêm danh mục',
      field('name', 'Tên danh mục', c.name || '', 'text', 'required') +
        field('slug', 'Đường dẫn', c.slug || '', 'text', 'placeholder="Tự tạo từ tên"') +
        textarea('description', 'Mô tả', c.description || ''),
      async (f) => {
        await api(scoped('/categories') + (c.id ? '/' + c.id : ''), c.id ? 'PUT' : 'POST', {
          name: f.get('name'),
          slug: f.get('slug') || slugify(String(f.get('name'))),
          description: f.get('description'),
        });
        await route();
      },
    );
  on('new-category-main', () => edit());
  main
    .querySelectorAll<HTMLElement>('[data-edit-category]')
    .forEach(
      (btn) => (btn.onclick = () => edit(rows.find((c) => c.id === btn.dataset.editCategory))),
    );
  main.querySelectorAll<HTMLElement>('[data-delete-category]').forEach(
    (btn) =>
      (btn.onclick = () =>
        modal(
          'Xóa danh mục?',
          `<p>Bài viết được giữ lại, nhưng không còn thuộc danh mục này.</p>`,
          async () => {
            await api(scoped('/categories/' + btn.dataset.deleteCategory), 'DELETE');
            await route();
          },
          'Xóa danh mục',
        )),
  );
}
async function editor(main: HTMLElement, postId: string) {
  if (needSite(main)) return;
  const { mountEditor } = await import('./editor');
  const controller = await mountEditor(main, {
    site: currentSite()!,
    userId: me!.id,
    postId: postId || 'new',
    api,
    can,
    toast,
    onSaved(id) {
      const hash = '#editor/' + id;
      history.replaceState(null, '', hash);
      activeHash = hash;
    },
  });
  if (!main.isConnected) controller.destroy();
  else editorController = controller;
}
function seoModal(entityId: string, seo: any, after: () => Promise<void>) {
  modal(
    'Cấu hình SEO',
    field('seo_title', 'SEO title', seo.seo_title) +
      textarea('description', 'Meta description', seo.description, 3) +
      field(
        'canonical_override',
        'Canonical override (để trống = tự động)',
        seo.canonical_override,
      ) +
      field('og_image', 'URL ảnh Open Graph', seo.og_image) +
      select(
        'schema_type',
        'Structured data',
        [
          ['BlogPosting', 'BlogPosting'],
          ['Article', 'Article'],
          ['WebPage', 'WebPage'],
        ],
        seo.schema_type || 'BlogPosting',
      ) +
      `<label><input type="checkbox" name="noindex" ${seo.noindex ? 'checked' : ''}> Noindex</label><label><input type="checkbox" name="nofollow" ${seo.nofollow ? 'checked' : ''}> Nofollow</label>`,
    async (f) => {
      await api(scoped('/seo/' + entityId), 'PUT', {
        seo_title: f.get('seo_title') || null,
        description: f.get('description') || null,
        canonical_override: f.get('canonical_override') || null,
        og_image: f.get('og_image') || null,
        schema_type: f.get('schema_type'),
        noindex: f.has('noindex'),
        nofollow: f.has('nofollow'),
        schema_overrides_json: seo.schema_overrides_json || '{}',
      });
      await after();
      toast('Đã lưu SEO.');
    },
  );
}
async function seoView(main: HTMLElement) {
  const [issues, redirects, seo] = await Promise.all([
    api(scoped('/seo_audit_results?limit=100')),
    api(scoped('/redirects?limit=100')),
    api(scoped('/seo/' + siteId)),
  ]);
  const open = issues.filter((i: any) => i.status === 'open');
  main.innerHTML =
    heading(
      'SEO',
      currentSite()!.name,
      button('SEO website', 'site-seo') + button('Chạy SEO audit', 'run-audit', true),
    ) +
    panel(
      `Vấn đề đang mở · ${open.length}`,
      open.length
        ? table(
            ['Mức độ', 'Trang', 'Quy tắc', 'Chi tiết'],
            open.map(
              (i: any) =>
                `<tr><td>${badge(i.severity)}</td><td>${e(i.path)}</td><td>${e(i.rule)}</td><td>${e(i.details)}</td></tr>`,
            ),
          )
        : empty(
            'Chưa có vấn đề đang mở',
            'Chạy audit sau khi xuất bản để kiểm tra nội dung và liên kết.',
          ),
    ) +
    panel(
      'Redirects',
      redirects.length
        ? table(
            ['Đường dẫn cũ', 'Đích', 'Mã', ''],
            redirects.map(
              (r: any) =>
                `<tr><td>${e(r.source_path)}</td><td>${e(r.target)}</td><td>${r.status_code}</td><td><button data-delete-redirect="${r.id}">Xóa</button></td></tr>`,
            ),
          )
        : empty('Chưa có redirect', 'Đổi slug bài đã xuất bản sẽ tự tạo redirect 301.'),
      button('+ Thêm redirect', 'add-redirect'),
    );
  on('run-audit', async () => {
    await api(scoped('/audit'), 'POST', {});
    toast('Audit đã vào hàng đợi. Xem tiến độ tại Hệ thống.');
  });
  on('site-seo', () => seoModal(siteId, seo, async () => {}));
  on('add-redirect', () =>
    modal(
      'Thêm redirect',
      field('source_path', 'Đường dẫn cũ', '/old-path') +
        field('target', 'Đích', '/new-path') +
        select('status_code', 'Loại', [
          ['301', '301 · Vĩnh viễn'],
          ['302', '302 · Tạm thời'],
        ]),
      async (f) => {
        await api(scoped('/redirects'), 'POST', {
          ...Object.fromEntries(f),
          status_code: Number(f.get('status_code')),
        });
        await route();
      },
    ),
  );
  document.querySelectorAll<HTMLElement>('[data-delete-redirect]').forEach(
    (el) =>
      (el.onclick = () =>
        modal(
          'Xóa redirect?',
          `<p>Yêu cầu tới đường dẫn cũ sẽ không còn được chuyển tiếp.</p>`,
          async () => {
            await api(scoped('/redirects/' + el.dataset.deleteRedirect), 'DELETE');
            await route();
          },
          'Xóa',
        )),
  );
}
function performanceTable(rows: any[]) {
  return table(
    ['Website / Trang', 'Clicks', 'Δ Clicks', 'Impressions', 'CTR', 'Vị trí', 'Đồng bộ'],
    rows.map(
      (r) =>
        `<tr><td><strong>${e(r.path || r.name)}</strong><small>${e(r.primary_domain)}</small></td><td>${fmt(r.clicks)}</td><td>${diff(r.click_delta)}</td><td>${fmt(r.impressions)}</td><td>${fmt(r.ctr * 100)}%</td><td>${fmt(r.position)}</td><td>${date(r.last_sync)}</td></tr>`,
    ),
  );
}
async function analyticsView(main: HTMLElement) {
  main.innerHTML =
    heading(
      'Analytics',
      'So sánh hiệu quả tìm kiếm với kỳ trước có cùng số ngày.',
      siteId
        ? button('Kết nối Search Console', 'connect-gsc') + button('Đồng bộ', 'sync-gsc', true)
        : '',
    ) +
    `<div class="toolbar"><label>Từ <input id="analytics-start" aria-label="Từ ngày" type="date" value="${new Date(Date.now() - 28 * 86400000).toISOString().slice(0, 10)}"></label><label>Đến <input id="analytics-end" aria-label="Đến ngày" type="date" value="${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}"></label><select id="analytics-mode" aria-label="Bộ lọc"><option value="sites">Tất cả</option><option value="winners">Tăng trưởng</option><option value="losers">Sụt giảm</option>${siteId ? '<option value="pages">Trang</option>' : ''}</select>${button('Áp dụng', 'load-analytics')}</div><div id="analytics-results"></div>`;
  const load = async () => {
    const start = (document.querySelector('#analytics-start') as HTMLInputElement).value,
      end = (document.querySelector('#analytics-end') as HTMLInputElement).value,
      mode = (document.querySelector('#analytics-mode') as HTMLSelectElement).value;
    const result = await api(
      (siteId
        ? scoped('/analytics/' + (mode === 'pages' ? 'pages' : 'sites'))
        : '/analytics/sites') + `?start=${start}&end=${end}&minimum=10`,
    );
    const rows =
      mode === 'winners' ? result.winners : mode === 'losers' ? result.losers : result.sites;
    document.querySelector('#analytics-results')!.innerHTML =
      panel(
        'Hiệu quả tìm kiếm',
        rows.length
          ? performanceTable(rows)
          : empty(
              'Chưa có dữ liệu trong khoảng thời gian này',
              'Kết nối thuộc tính Search Console của website và đồng bộ dữ liệu. Google có thể trả dữ liệu trễ vài ngày.',
            ),
      ) +
      (siteId
        ? panel('Xu hướng theo ngày', '<div id="daily-data" class="chart-table"></div>')
        : '');
    if (siteId) {
      const daily = await api(scoped('/analytics/daily') + `?start=${start}&end=${end}`);
      document.querySelector('#daily-data')!.innerHTML = daily.length
        ? table(
            ['Ngày', 'Clicks', 'Impressions', 'Vị trí'],
            daily.map(
              (r: any) =>
                `<tr><td>${e(r.date)}</td><td>${fmt(r.clicks)}</td><td>${fmt(r.impressions)}</td><td>${fmt(r.position)}</td></tr>`,
            ),
          )
        : empty('Chưa có dữ liệu ngày', 'Dữ liệu xuất hiện sau lần đồng bộ thành công.');
    }
  };
  await load();
  on('load-analytics', load);
  on('connect-gsc', () =>
    modal(
      'Kết nối Search Console',
      field('property', 'Thuộc tính', `sc-domain:${currentSite()!.primary_domain}`) +
        `<p class="hint">Thông tin OAuth phải được quản trị hệ thống cấu hình ở Worker secrets. Chỉ chấp nhận thuộc tính đúng domain của website này.</p>`,
      async (f) => {
        await api(scoped('/analytics'), 'PUT', Object.fromEntries(f));
        toast('Đã lưu thuộc tính.');
      },
    ),
  );
  on('sync-gsc', async () => {
    await api(scoped('/analytics/sync'), 'POST', {});
    toast('Đã xếp lịch đồng bộ. Kiểm tra Hệ thống / Jobs.');
  });
}
async function mediaView(main: HTMLElement) {
  const items = await api(scoped('/media?limit=100'));
  main.innerHTML =
    heading('Thư viện ảnh', currentSite()!.name, button('+ Tải ảnh lên', 'upload-media', true)) +
    (items.length
      ? `<div class="media-grid">${items.map((m: any) => `<article class="media-card"><img src="/api/v1/sites/${siteId}/media/${m.id}/file" alt="${e(m.alt)}" width="${m.width}" height="${m.height}" loading="lazy"><div class="panel-body"><strong>${e(m.filename)}</strong><p>${m.width} × ${m.height} · ${fmt(m.bytes / 1024)} KB</p><div class="actions"><button data-copy-media="${m.id}">Markdown</button><button data-edit-media="${m.id}">Alt text</button></div></div></article>`).join('')}</div>`
      : panel(
          'Ảnh website',
          empty('Chưa có ảnh', 'Tải ảnh PNG, JPEG hoặc GIF. Mỗi ảnh tối đa 10 MB.'),
        ));
  on('upload-media', () =>
    modal(
      'Tải ảnh lên',
      `<label><span>Ảnh</span><input type="file" name="file" accept="image/png,image/jpeg,image/gif" required></label>` +
        field('alt', 'Mô tả thay thế (alt)', '', 'text', 'required'),
      async (f) => {
        await api(scoped('/media'), 'POST', f);
        await route();
      },
      'Tải lên',
    ),
  );
  document.querySelectorAll<HTMLElement>('[data-copy-media]').forEach(
    (el) =>
      (el.onclick = () => {
        const m = items.find((m: any) => m.id === el.dataset.copyMedia);
        void navigator.clipboard
          .writeText(`![${m.alt}](/media/${m.id})`)
          .then(() => toast('Đã sao chép Markdown.'))
          .catch(() => toast('Không truy cập được clipboard.'));
      }),
  );
  document.querySelectorAll<HTMLElement>('[data-edit-media]').forEach(
    (el) =>
      (el.onclick = () => {
        const m = items.find((m: any) => m.id === el.dataset.editMedia);
        modal(
          'Mô tả ảnh',
          field('alt', 'Alt text', m.alt) +
            field('title', 'Tiêu đề', m.title) +
            textarea('caption', 'Chú thích', m.caption),
          async (f) => {
            await api(scoped('/media/' + m.id), 'PATCH', Object.fromEntries(f));
            await route();
          },
        );
      }),
  );
}
async function usersView(main: HTMLElement) {
  const users = await api(siteId ? scoped('/members') : '/users');
  main.innerHTML =
    heading(
      siteId ? 'Thành viên website' : 'Người dùng',
      siteId ? currentSite()!.name : 'Tài khoản và phân quyền truy cập',
      button(siteId ? '+ Thêm thành viên' : '+ Tạo người dùng', 'add-user', true),
    ) +
    panel(
      'Danh sách',
      users.length
        ? table(
            ['Người dùng', 'Email', 'Vai trò'],
            users.map(
              (u: any) =>
                `<tr><td>${e(u.display_name)}</td><td>${e(u.email)}</td><td>${badge(u.role)}</td></tr>`,
            ),
          )
        : empty(
            'Chưa có thành viên',
            'Tạo người dùng ở chế độ tổng hợp rồi cấp vai trò cho từng website.',
          ),
    );
  on('add-user', async () => {
    if (siteId) {
      const all = await api('/users');
      modal(
        'Thêm thành viên',
        select(
          'user_id',
          'Người dùng',
          all.map((u: any) => [u.id, u.email]),
        ) +
          select('role', 'Vai trò', [
            ['editor', 'Editor'],
            ['author', 'Author'],
            ['analyst', 'Analyst'],
            ['viewer', 'Viewer'],
            ['site_admin', 'Site admin'],
          ]),
        async (f) => {
          await api(scoped('/members'), 'POST', Object.fromEntries(f));
          await route();
        },
      );
    } else
      modal(
        'Tạo người dùng',
        field('email', 'Email', '', 'email', 'required') +
          field('display_name', 'Tên hiển thị', '', 'text', 'required') +
          field(
            'password',
            'Mật khẩu (ít nhất 12 ký tự)',
            '',
            'password',
            'required minlength="12" autocomplete="new-password"',
          ) +
          select('role', 'Vai trò hệ thống', [
            ['member', 'Thành viên'],
            ['super_admin', 'Super admin'],
          ]),
        async (f) => {
          await api('/users', 'POST', Object.fromEntries(f));
          await route();
        },
      );
  });
}
async function codeView(main: HTMLElement) {
  const items = await api(siteId ? scoped('/code_snippets') : '/system/snippets');
  main.innerHTML =
    heading(
      'Code Manager',
      siteId ? currentSite()!.name : 'Phạm vi toàn hệ thống · yêu cầu super admin',
      button('+ Tạo snippet', 'add-snippet', true),
    ) +
    panel(
      'Placements',
      items.length
        ? table(
            ['Tên', 'Vị trí', 'Trạng thái', 'Phiên bản', ''],
            items.map(
              (s: any) =>
                `<tr><td>${e(s.name)}<small>${s.executable ? 'Executable' : 'HTML đã sanitize'}</small></td><td>${e(s.placement)}</td><td>${badge(s.enabled ? 'active' : 'draft')}</td><td>${s.version}</td><td><button data-snippet="${s.id}">Chỉnh sửa</button></td></tr>`,
            ),
          )
        : empty('Chưa có snippet', 'Thêm banner hoặc mã được phép tại các vị trí của theme.'),
    );
  const edit = (s: any = {}) =>
    modal(
      s.id ? 'Sửa snippet' : 'Tạo snippet',
      field('name', 'Tên', s.name || '') +
        select(
          'placement',
          'Vị trí',
          [
            'head',
            'body_start',
            'body_end',
            'header_banner',
            'before_content',
            'after_content',
            'sidebar',
            'footer_banner',
          ].map((v) => [v, v]),
          s.placement,
        ) +
        textarea('content', 'Nội dung HTML', s.content || '', 8) +
        textarea('targeting', 'Targeting JSON', s.targeting || '{}', 3) +
        field('priority', 'Ưu tiên', s.priority || 0, 'number') +
        `<label><input type="checkbox" name="enabled" ${s.enabled ? 'checked' : ''}> Bật snippet</label>${me?.superAdmin ? `<label><input type="checkbox" name="executable" ${s.executable ? 'checked' : ''}> Cho phép JavaScript nội tuyến</label>` : ''}` +
        (!siteId
          ? field('confirmation', 'Nhập APPLY GLOBAL CODE để xác nhận', '', 'text', 'required')
          : ''),
      async (f) => {
        const data = {
          name: f.get('name'),
          placement: f.get('placement'),
          content: f.get('content'),
          targeting: JSON.parse(String(f.get('targeting'))),
          priority: Number(f.get('priority')),
          enabled: f.has('enabled'),
          executable: f.has('executable'),
          ...(s.id ? { version: s.version } : {}),
          ...(!siteId ? { confirmation: f.get('confirmation') } : {}),
        };
        await api(
          (siteId ? scoped('/snippets') : '/system/snippets') + (s.id ? '/' + s.id : ''),
          s.id ? 'PUT' : 'POST',
          data,
        );
        await route();
      },
    );
  on('add-snippet', () => edit());
  document
    .querySelectorAll<HTMLElement>('[data-snippet]')
    .forEach(
      (el) => (el.onclick = () => edit(items.find((s: any) => s.id === el.dataset.snippet))),
    );
}
async function credentialsView(main: HTMLElement) {
  const items = await api('/credentials');
  main.innerHTML =
    heading(
      'API / MCP',
      'Credential chỉ được hiển thị một lần khi tạo.',
      button('+ Tạo credential', 'add-credential', true),
    ) +
    panel(
      'Credentials',
      items.length
        ? table(
            ['Tên', 'Loại / Phạm vi', 'Trạng thái', 'Lần dùng cuối', ''],
            items.map(
              (c: any) =>
                `<tr><td><strong>${e(c.name)}</strong><small>${e(JSON.parse(c.scopes).join(', '))}</small></td><td>${e(c.type)}<small>${e(c.site_id || 'System')}</small></td><td>${badge(c.status)}</td><td>${date(c.last_used)}</td><td><button data-revoke="${c.id}">Thu hồi</button></td></tr>`,
            ),
          )
        : empty(
            'Chưa có credential',
            'Tạo system credential cho backend / AI, hoặc site credential cho một tích hợp riêng.',
          ),
    ) +
    panel(
      'Kết nối MCP',
      `<div class="panel-body"><p>Endpoint: <code>${e(location.origin)}/mcp</code></p><p class="hint">Streamable HTTP · MCP 2025-11-25 · Xác thực Bearer. Quyền tạo, sửa và xuất bản tuân theo scopes của credential.</p><pre>{"url":"${e(location.origin)}/mcp","headers":{"Authorization":"Bearer &lt;credential&gt;"}}</pre></div>`,
    );
  on('add-credential', () =>
    modal(
      'Tạo credential',
      field('name', 'Tên credential', '', 'text', 'required') +
        select('type', 'Loại', [
          ['site', 'Site'],
          ['service', 'Service'],
          ['system', 'System'],
        ]) +
        select(
          'site_id',
          'Website',
          [
            ['', 'Không giới hạn (system)'],
            ...sites.map((s) => [s.id, s.name] as [string, string]),
          ],
          siteId,
        ) +
        field(
          'scopes',
          'Scopes, cách nhau bằng dấu phẩy',
          'sites:read,content:read,content:write',
        ) +
        field('expires_at', 'Hết hạn (tùy chọn)', '', 'datetime-local'),
      async (f) => {
        const type = f.get('type');
        const result = await api('/credentials', 'POST', {
          name: f.get('name'),
          type,
          ...(type !== 'system' ? { site_id: f.get('site_id') } : {}),
          scopes: String(f.get('scopes'))
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          ...(f.get('expires_at')
            ? { expires_at: new Date(String(f.get('expires_at'))).toISOString() }
            : {}),
        });
        download(JSON.stringify(result, null, 2), 'penlum-credential.json');
        toast('Credential đã tải xuống. Lưu ở nơi an toàn; không thể xem lại.');
        await route();
      },
      'Tạo & tải xuống',
    ),
  );
  document.querySelectorAll<HTMLElement>('[data-revoke]').forEach(
    (el) =>
      (el.onclick = () =>
        modal(
          'Thu hồi credential?',
          `<p>Tích hợp sử dụng credential này sẽ mất quyền truy cập ngay.</p>`,
          async () => {
            await api('/credentials/' + el.dataset.revoke, 'DELETE');
            await route();
          },
          'Thu hồi',
        )),
  );
}
async function systemView(main: HTMLElement) {
  const [health, jobs, audit] = await Promise.all([
    api('/system/health'),
    api('/system/jobs'),
    api('/system/audit'),
  ]);
  main.innerHTML =
    heading(
      'Hệ thống',
      'Runtime, hàng đợi và lịch sử thay đổi.',
      button('Làm mới', 'refresh-system'),
    ) +
    `<div class="metrics"><div class="metric"><span>Database</span><strong>${e(health.database)}</strong><small>Cloudflare D1</small></div><div class="metric"><span>Media storage</span><strong>${e(health.r2)}</strong><small>Cloudflare R2</small></div><div class="metric"><span>Jobs thất bại</span><strong>${health.failed_jobs.count}</strong><small>Có thể thử lại bên dưới</small></div><div class="metric"><span>Môi trường</span><strong>${e(health.environment)}</strong><small>${e(health.runtime)}</small></div></div>` +
    panel(
      'Jobs',
      jobs.length
        ? table(
            ['Loại', 'Website', 'Trạng thái', 'Chi tiết', ''],
            jobs.map(
              (j: any) =>
                `<tr><td>${e(j.type)}</td><td>${e(sites.find((s) => s.id === j.site_id)?.name || j.site_id || 'System')}</td><td>${badge(j.status)}</td><td>${e(j.error || date(j.updated_at))}</td><td>${j.status === 'failed' ? `<button data-retry-job="${j.id}">Thử lại</button>` : ''}</td></tr>`,
            ),
          )
        : empty('Chưa có job', 'Audit, export và analytics sẽ xuất hiện tại đây.'),
    ) +
    panel(
      'Audit log',
      table(
        ['Thời gian', 'Actor', 'Hành động', 'Tài nguyên'],
        audit.map(
          (a: any) =>
            `<tr><td>${e(new Date(a.created_at).toLocaleString('vi-VN'))}</td><td>${e(a.actor_type)}<small>${e(a.actor_id)}</small></td><td>${e(a.action)}</td><td>${e(a.resource)}</td></tr>`,
        ),
      ),
    ) +
    panel(
      'Analytics sync',
      `<div class="panel-body"><pre>${e(JSON.stringify(health.analytics, null, 2))}</pre></div>`,
    );
  on('refresh-system', route);
  document.querySelectorAll<HTMLElement>('[data-retry-job]').forEach(
    (el) =>
      (el.onclick = () =>
        void api('/system/jobs/' + el.dataset.retryJob + '/retry', 'POST', {})
          .then(route)
          .catch((err) => toast(err.message))),
  );
}
window.addEventListener('keydown', (event) => {
  if (
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === 'k' &&
    view !== 'editor' &&
    me
  ) {
    event.preventDefault();
    commandPalette();
  }
});
window.addEventListener('hashchange', () => void route());
void boot().catch(() => login());
