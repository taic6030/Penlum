import Editor from '@toast-ui/editor';
import type { Site, Post } from '../../../packages/shared/src/models';
import {
  escapeHTML as e,
  icon,
  iconButton,
  slugify,
  readingStats,
  publicURL,
  contentToEditor,
  contentFromEditor,
  SaveQueue,
} from './ui';
type Media = {
  id: string;
  filename: string;
  alt: string;
  width: number;
  height: number;
  bytes: number;
};
type Category = { id: string; name: string; slug: string };
type EditablePost = Pick<
  Post,
  'title' | 'slug' | 'type' | 'excerpt' | 'markdown_content' | 'featured_media'
> & { category_ids: string[] };
interface Host {
  site: Site;
  userId: string;
  postId: string;
  api: (path: string, method?: string, data?: unknown) => Promise<any>;
  can: (scope: string) => boolean;
  toast: (message: string) => void;
  onSaved: (id: string) => void;
}
export interface EditorController {
  destroy(): void;
  beforeLeave(): Promise<boolean>;
}
export async function mountEditor(main: HTMLElement, host: Host): Promise<EditorController> {
  const { site, api, can } = host,
    base = `/sites/${site.id}`;
  let post: (Post & { category_ids: string[] }) | null =
    host.postId === 'new' ? null : await api(`${base}/posts/${host.postId}`);
  if (!main.isConnected)
    return {
      destroy() {},
      async beforeLeave() {
        return true;
      },
    };
  if (!can('content:write')) {
    if (!post) {
      main.innerHTML =
        '<div class="empty"><h2>Tài khoản chỉ có quyền xem</h2><a href="#content">Quay lại nội dung</a></div>';
      return {
        destroy() {},
        async beforeLeave() {
          return true;
        },
      };
    }
    main.innerHTML = `<div class="read-only-head"><a href="#content">${icon('arrow-left')} Nội dung</a><span>${icon('lock')} Chế độ chỉ đọc</span></div><iframe class="read-only-preview" title="Nội dung bài viết" sandbox src="/api/v1${base}/posts/${post!.id}/preview"></iframe>`;
    return {
      destroy() {},
      async beforeLeave() {
        return true;
      },
    };
  }
  async function allResources<T extends { id: string }>(path: string): Promise<T[]> {
    const rows: T[] = [];
    let cursor = '';
    while (true) {
      const batch: T[] = await api(
        `${base}/${path}?limit=100&cursor=${encodeURIComponent(cursor)}`,
      );
      rows.push(...batch);
      if (batch.length < 100) break;
      cursor = batch.at(-1)!.id;
    }
    return rows;
  }
  const [loadedMedia, loadedCategories] = await Promise.all([
    allResources<Media>('media'),
    allResources<Category>('categories'),
  ]);
  let media = loadedMedia,
    categories = loadedCategories;
  let seo: any = post && can('seo:read') ? await api(`${base}/seo/${post.id}`) : {};
  if (!main.isConnected)
    return {
      destroy() {},
      async beforeLeave() {
        return true;
      },
    };
  let destroyed = false,
    changed = 0,
    savedChange = 0,
    slugTouched = !!post,
    timer: ReturnType<typeof setTimeout>,
    focus = false;
  let initial: EditablePost = {
    title: post?.title || '',
    slug: post?.slug || '',
    type:
      post?.type ||
      (new URLSearchParams(location.hash.split('?')[1] || '').get('type') === 'page'
        ? 'page'
        : 'post'),
    excerpt: post?.excerpt || '',
    markdown_content: post?.markdown_content || '',
    featured_media: post?.featured_media || null,
    category_ids: post?.category_ids || [],
  };
  let recoveryKey = `penlum:draft:${host.userId}:${site.id}:${post?.id || 'new'}`;
  let recovered: { post: EditablePost; seo: any; version: number; time: string } | null = null;
  try {
    recovered = JSON.parse(localStorage.getItem(recoveryKey) || 'null');
  } catch {}
  main.classList.add('editor-main-surface');
  main.innerHTML = `<div class="editor-top"><div class="editor-top-left"><a class="editor-back" href="#content" aria-label="Quay lại danh sách nội dung" title="Quay lại nội dung">${icon('arrow-left')}</a><span class="editor-context">${e(site.name)}<small id="editor-doc-label">${post ? 'Chỉnh sửa ' + (post.type === 'page' ? 'trang' : 'bài viết') : initial.type === 'page' ? 'Trang mới' : 'Bài viết mới'}</small></span></div><div class="editor-top-actions"><span id="save-state" class="save-state" role="status" aria-live="polite">${icon('cloud-arrow-up')} ${post ? 'Đã lưu' : 'Bản nháp mới'}</span>${iconButton('rotate-left', 'Hoàn tác (⌘Z)', 'editor-undo')}${iconButton('rotate-right', 'Làm lại (⌘⇧Z)', 'editor-redo')}<span class="toolbar-divider"></span><button id="preview" class="secondary" aria-label="Xem trước">${icon('eye')} <span>Xem trước</span></button><button id="save-post">${icon('floppy-disk')} <span>${post && ['published', 'scheduled'].includes(post.status) ? 'Lưu trên máy' : 'Lưu nháp'}</span></button>${can('content:publish') ? `<button id="publish" class="primary">${icon(post?.status === 'published' ? 'check' : 'paper-plane')} <span>${post && ['published', 'scheduled'].includes(post.status) ? 'Cập nhật' : 'Xuất bản'}</span></button>` : ''}${iconButton('sliders', 'Đóng / mở cài đặt', 'editor-settings')}</div></div>
 <div class="editor-layout"><section class="writing-workspace"><div class="writing-toolbar"><div class="format-tools" role="toolbar" aria-label="Định dạng nội dung"><select id="block-format" aria-label="Kiểu đoạn văn"><option value="0">Đoạn văn</option><option value="2">Tiêu đề 2</option><option value="3">Tiêu đề 3</option><option value="4">Tiêu đề 4</option></select><span class="toolbar-divider"></span>${[
   ['bold', 'Đậm (⌘B)', 'bold'],
   ['italic', 'Nghiêng (⌘I)', 'italic'],
   ['strikethrough', 'Gạch ngang', 'strike'],
   ['link', 'Chèn liên kết', 'link'],
   ['list-ul', 'Danh sách', 'bulletList'],
   ['list-ol', 'Danh sách số', 'orderedList'],
   ['quote-left', 'Trích dẫn', 'blockQuote'],
   ['image', 'Chèn ảnh', 'image'],
   ['table-cells', 'Chèn bảng', 'table'],
   ['code', 'Đoạn mã', 'codeBlock'],
 ]
   .map(
     ([i, label, command]) =>
       `<button type="button" class="icon-button" data-format="${command}" title="${label}" aria-label="${label}">${icon(i)}</button>`,
   )
   .join(
     '',
   )}</div><div class="editor-view-tools"><div class="segmented" aria-label="Chế độ viết"><button id="visual-mode" class="active" aria-pressed="true">Trực quan</button><button id="markdown-mode" aria-pressed="false">Markdown</button></div>${iconButton('expand', 'Chế độ tập trung', 'focus-mode')}</div></div>
 <div id="recovery-notice"></div><div id="editor-error" class="editor-error" role="alert" hidden></div>
 <div class="writing-scroll"><div class="writing-paper"><div class="document-kicker">${icon(initial.type === 'page' ? 'file-lines' : 'pen-nib')} <span id="document-kind">${initial.type === 'page' ? 'TRANG' : 'BÀI VIẾT'}</span></div><textarea id="post-title" class="document-title" rows="2" maxlength="240" placeholder="Thêm tiêu đề…" aria-label="Tiêu đề bài viết">${e(initial.title)}</textarea><div class="document-byline"><span>${icon('globe')} ${e(site.primary_domain)}</span><span id="document-status">${statusText()}</span></div><div id="rich-editor"></div></div></div><footer class="editor-footer"><span id="word-count">0 từ · 1 phút đọc</span><span>${icon('keyboard')} ⌘/Ctrl + S để lưu <span class="footer-separator">·</span> <span id="footer-save">Nội dung được lưu dưới dạng Markdown</span></span></footer></section>
 <aside class="document-sidebar"><div class="inspector-tabs" role="tablist" aria-label="Cài đặt bài viết"><button role="tab" aria-selected="true" data-side="post">${icon('file-lines')} Bài viết</button>${can('seo:read') ? `<button role="tab" aria-selected="false" data-side="seo">${icon('magnifying-glass')} SEO</button>` : ''}<button role="tab" aria-selected="false" data-side="outline">${icon('list')} Mục lục</button></div>
 <div class="inspector-panel" id="panel-post" role="tabpanel"><section class="inspector-section"><h3>Thông tin xuất bản</h3><div class="property-row"><span>Trạng thái</span><strong id="inspector-status">${statusText()}</strong></div><div class="property-row"><span>Hiển thị</span><strong>${site.status === 'active' ? 'Theo website' : 'Website đang staging'}</strong></div><label><span>Đường dẫn</span><div class="slug-input"><span>/</span><input id="post-slug" maxlength="180" value="${e(initial.slug)}" placeholder="tu-dong-tu-tieu-de"></div><small id="slug-hint">Tự tạo từ tiêu đề; có thể chỉnh sửa.</small></label><label><span>Loại nội dung</span><select id="post-type"><option value="post" ${initial.type === 'post' ? 'selected' : ''}>Bài viết</option><option value="page" ${initial.type === 'page' ? 'selected' : ''}>Trang</option></select></label>${post?.published_at ? `<p class="field-hint">Xuất bản ${e(new Date(post.published_at).toLocaleString('vi-VN'))}</p>` : ''}</section>
 <section class="inspector-section"><h3>Ảnh đại diện</h3><div id="featured-image"></div></section>
 <section class="inspector-section"><h3>Danh mục <button type="button" class="text-button" id="new-category">${icon('plus')} Thêm</button></h3><div class="category-checklist" id="category-checklist"></div></section>
 <section class="inspector-section"><h3>Tóm tắt</h3><label><span class="sr-only">Tóm tắt bài viết</span><textarea id="post-excerpt" rows="4" maxlength="1000" placeholder="Giới thiệu ngắn để người đọc muốn xem tiếp…">${e(initial.excerpt)}</textarea></label><p class="field-hint">Hiển thị ở danh sách bài viết và làm mô tả SEO mặc định.</p></section>
 ${can('content:publish') ? `<section class="inspector-section" id="unpublish-section" ${post?.status !== 'published' && post?.status !== 'scheduled' ? 'hidden' : ''}><button class="text-button danger" id="unpublish">${icon('file-pen')} Chuyển về bản nháp</button></section>` : ''}
 </div><div class="inspector-panel" id="panel-seo" role="tabpanel" hidden><section class="inspector-section"><h3>Kết quả tìm kiếm</h3><div class="serp-card"><span>${e(site.name)}</span><small id="serp-url"></small><strong id="serp-title"></strong><p id="serp-description"></p></div><p class="field-hint">Bản xem trước minh họa; Google có thể chọn nội dung khác.</p></section><section class="inspector-section"><label><span>Tiêu đề SEO <small id="seo-title-count"></small></span><input id="seo-title" maxlength="240" value="${e(seo.seo_title || '')}" placeholder="Dùng tiêu đề bài viết" ${!can('seo:write') ? 'disabled' : ''}></label><label><span>Mô tả SEO <small id="seo-description-count"></small></span><textarea id="seo-description" rows="5" maxlength="1000" placeholder="Dùng phần tóm tắt" ${!can('seo:write') ? 'disabled' : ''}>${e(seo.description || '')}</textarea></label><p class="field-hint">Gợi ý: tiêu đề khoảng 50–60 ký tự, mô tả 140–160 ký tự. Đây không phải giới hạn xếp hạng.</p></section><details class="inspector-section"><summary>Cài đặt nâng cao</summary><label><span>Canonical</span><input id="seo-canonical" value="${e(seo.canonical_override || '')}" placeholder="Tự động" ${!can('seo:write') ? 'disabled' : ''}></label><label><span>Ảnh chia sẻ (URL)</span><input id="seo-og" value="${e(seo.og_image || '')}" placeholder="https://…" ${!can('seo:write') ? 'disabled' : ''}></label><label><span>Dữ liệu có cấu trúc</span><select id="seo-schema" ${!can('seo:write') ? 'disabled' : ''}>${['BlogPosting', 'Article', 'WebPage'].map((t) => `<option ${seo.schema_type === t ? 'selected' : ''}>${t}</option>`).join('')}</select></label><label class="check-label"><input id="seo-noindex" type="checkbox" ${seo.noindex ? 'checked' : ''} ${!can('seo:write') ? 'disabled' : ''}> Không cho lập chỉ mục (noindex)</label><label class="check-label"><input id="seo-nofollow" type="checkbox" ${seo.nofollow ? 'checked' : ''} ${!can('seo:write') ? 'disabled' : ''}> Không theo liên kết (nofollow)</label></details></div>
 <div class="inspector-panel" id="panel-outline" role="tabpanel" hidden><section class="inspector-section"><h3>Cấu trúc bài viết</h3><div id="outline-stats"></div><nav id="outline-list" aria-label="Mục lục bài viết"></nav><p class="field-hint">H1 lấy từ tiêu đề. Dùng H2 và H3 để chia nội dung dễ đọc.</p></section><section class="inspector-section"><h3>Liên kết nội bộ</h3><p class="field-hint">Gợi ý chỉ từ website này.</p><div id="link-suggestions"><button class="text-button" id="load-suggestions">${icon('link')} Tìm bài viết để liên kết</button></div></section></div></aside></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
    main.querySelector<T>(selector)!;
  const title = $<HTMLTextAreaElement>('#post-title'),
    slug = $<HTMLInputElement>('#post-slug'),
    excerpt = $<HTMLTextAreaElement>('#post-excerpt');
  const rich = new Editor({
    el: $('#rich-editor'),
    initialValue: contentToEditor(initial.markdown_content, site.id),
    initialEditType: 'wysiwyg',
    hideModeSwitch: true,
    toolbarItems: [],
    height: 'auto',
    minHeight: '420px',
    placeholder: 'Bắt đầu kể câu chuyện của bạn…',
    usageStatistics: false,
    autofocus: false,
    linkAttributes: { rel: 'noopener noreferrer', target: '_blank' },
    hooks: {
      addImageBlobHook: (blob: Blob | File, callback: (url: string, alt?: string) => void) => {
        void uploadImage(blob)
          .then((m) => callback(`/api/v1${base}/media/${m.id}/file`, m.alt))
          .catch(showError);
      },
    },
  });
  for (const el of main.querySelectorAll<HTMLElement>('#rich-editor [contenteditable=true]')) {
    el.setAttribute('role', 'textbox');
    el.setAttribute('aria-label', 'Nội dung bài viết');
    el.setAttribute('aria-multiline', 'true');
  }
  if (window.matchMedia('(max-width:760px)').matches) {
    $('.document-sidebar').classList.add('closed');
    $('.editor-layout').classList.add('sidebar-closed');
  }
  const queue = new SaveQueue();
  let baselinePost = JSON.stringify(initial),
    baselineSEO = JSON.stringify(seoData());
  function statusText() {
    return post?.status === 'published'
      ? 'Đã xuất bản'
      : post?.status === 'scheduled'
        ? 'Đã lên lịch'
        : 'Bản nháp';
  }
  function getData(): EditablePost {
    return {
      title: title.value.trim(),
      slug: slug.value.trim() || slugify(title.value),
      type: $<HTMLSelectElement>('#post-type').value as 'post' | 'page',
      excerpt: excerpt.value,
      markdown_content: contentFromEditor(rich.getMarkdown(), site.id),
      featured_media: initial.featured_media,
      category_ids: initial.category_ids,
    };
  }
  function seoData() {
    return {
      ...seo,
      seo_title: $<HTMLInputElement>('#seo-title')?.value || null,
      description: $<HTMLTextAreaElement>('#seo-description')?.value || null,
      canonical_override: $<HTMLInputElement>('#seo-canonical')?.value || null,
      og_image: $<HTMLInputElement>('#seo-og')?.value || null,
      schema_type: $<HTMLSelectElement>('#seo-schema')?.value || 'BlogPosting',
      noindex: $<HTMLInputElement>('#seo-noindex')?.checked || false,
      nofollow: $<HTMLInputElement>('#seo-nofollow')?.checked || false,
    };
  }
  function seoPayload() {
    const data = seoData();
    return Object.fromEntries(
      [
        'seo_title',
        'description',
        'canonical_override',
        'og_image',
        'schema_type',
        'noindex',
        'nofollow',
        'og_title',
        'og_description',
        'schema_overrides_json',
      ]
        .filter((k) => data[k] !== undefined)
        .map((k) => [k, data[k]]),
    );
  }
  function dirty() {
    return (
      JSON.stringify(getData()) !== baselinePost ||
      (can('seo:write') && JSON.stringify(seoData()) !== baselineSEO)
    );
  }
  function localSave() {
    try {
      if (dirty())
        localStorage.setItem(
          recoveryKey,
          JSON.stringify({
            post: getData(),
            seo: seoData(),
            version: post?.version || 0,
            time: new Date().toISOString(),
          }),
        );
      else if (!recovered) localStorage.removeItem(recoveryKey);
    } catch {
      if (!destroyed) $('#footer-save').textContent = 'Không thể lưu dự phòng trên máy này';
    }
  }
  function state(message: string, type = 'saved') {
    if (destroyed) return;
    $('#save-state').className = 'save-state ' + type;
    $('#save-state').innerHTML =
      icon(
        type === 'error'
          ? 'triangle-exclamation'
          : type === 'saving'
            ? 'arrows-rotate'
            : type === 'local'
              ? 'laptop'
              : 'cloud-arrow-up',
      ) +
      ' ' +
      e(message);
  }
  function showError(error: unknown) {
    if (destroyed) return;
    const el = $('#editor-error');
    el.hidden = false;
    el.innerHTML = `${icon('circle-exclamation')} <span>${e(error instanceof Error ? error.message : String(error))}</span><button id="retry-save" type="button">Thử lưu lại</button>`;
    el.querySelector('button')!.onclick = () => void save().catch(showError);
    state('Chưa lưu thành công', 'error');
    localSave();
  }
  function updateReadouts() {
    if (destroyed) return;
    title.style.height = 'auto';
    title.style.height = Math.max(90, title.scrollHeight) + 'px';
    const data = getData(),
      stats = readingStats(data.markdown_content);
    $('#word-count').textContent =
      `${stats.words.toLocaleString('vi-VN')} từ · ${stats.minutes} phút đọc`;
    $('#outline-stats').innerHTML =
      `<div class="outline-numbers"><strong>${stats.words}<small>từ</small></strong><strong>${stats.minutes}<small>phút đọc</small></strong></div>`;
    $('#serp-title').textContent =
      $<HTMLInputElement>('#seo-title').value || data.title || 'Tiêu đề bài viết';
    $('#serp-description').textContent =
      $<HTMLInputElement>('#seo-description').value ||
      data.excerpt ||
      'Thêm mô tả để người đọc hiểu nội dung của trang.';
    $('#serp-url').textContent = site.primary_domain + '/' + (data.slug || 'duong-dan-bai-viet');
    $('#seo-title-count').textContent = String($<HTMLInputElement>('#seo-title').value.length);
    $('#seo-description-count').textContent = String(
      $<HTMLTextAreaElement>('#seo-description').value.length,
    );
    const headings = [...data.markdown_content.matchAll(/^(#{1,6})\s+(.+)$/gm)];
    $('#outline-list').innerHTML = headings.length
      ? headings
          .map(
            (h, i) =>
              `<button type="button" data-heading="${i}"><span>H${h[1].length}</span>${e(h[2])}</button>`,
          )
          .join('')
      : '<p class="field-hint">Thêm một tiêu đề phụ để bắt đầu mục lục.</p>';
    $('#outline-list')
      .querySelectorAll<HTMLElement>('[data-heading]')
      .forEach(
        (btn) =>
          (btn.onclick = () => {
            const index = Number(btn.dataset.heading);
            const heading = main.querySelectorAll(
              '.toastui-editor-ww-container h1,.toastui-editor-ww-container h2,.toastui-editor-ww-container h3,.toastui-editor-ww-container h4,.toastui-editor-ww-container h5,.toastui-editor-ww-container h6',
            )[index];
            if (heading && !rich.isMarkdownMode())
              heading.scrollIntoView({ block: 'center', behavior: 'smooth' });
            else {
              const line = data.markdown_content.slice(0, headings[index].index).split('\n').length;
              rich.setSelection([line, 1]);
              rich.focus();
            }
          }),
      );
  }
  function change() {
    if (destroyed) return;
    changed++;
    if (!slugTouched) slug.value = slugify(title.value);
    updateReadouts();
    localSave();
    clearTimeout(timer);
    if (!dirty()) {
      state('Đã lưu');
      return;
    }
    if (post?.status === 'published' || post?.status === 'scheduled') {
      state('Bản chỉnh sửa trên máy', 'local');
      $('#footer-save').textContent = 'Chỉ thay đổi website khi bấm Cập nhật';
    } else {
      state('Chưa lưu', 'local');
      timer = setTimeout(() => {
        if (title.value.trim()) void save().catch(showError);
      }, 1600);
    }
  }
  function save(explicitUpdate = false): Promise<void> {
    clearTimeout(timer);
    return queue.run(async () => {
      if (!dirty() && post) {
        state('Đã lưu');
        return;
      }
      if ((post?.status === 'published' || post?.status === 'scheduled') && !explicitUpdate) {
        localSave();
        state('Đã lưu trên máy', 'local');
        host.toast('Bản chỉnh sửa đã lưu trên máy. Bấm Cập nhật để áp dụng lên website.');
        return;
      }
      const data = getData();
      if (!data.title) {
        title.focus();
        throw new Error('Thêm tiêu đề trước khi lưu bài viết.');
      }
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.slug)) {
        $<HTMLInputElement>('#post-slug').focus();
        throw new Error('Đường dẫn chỉ gồm chữ thường không dấu, số và dấu gạch ngang.');
      }
      const snapshot = JSON.stringify(data),
        seoSnapshot = JSON.stringify(seoData()),
        seoInput = seoPayload();
      state('Đang lưu…', 'saving');
      const startChange = changed;
      if (snapshot !== baselinePost || !post) {
        post = post
          ? await api(`${base}/posts/${post.id}`, 'PATCH', { ...data, version: post.version })
          : await api(`${base}/posts`, 'POST', data);
        baselinePost = snapshot;
        const oldKey = recoveryKey;
        recoveryKey = `penlum:draft:${host.userId}:${site.id}:${post!.id}`;
        try {
          if (oldKey !== recoveryKey) localStorage.removeItem(oldKey);
        } catch {}
        host.onSaved(post!.id);
      }
      if (can('seo:write') && seoSnapshot !== baselineSEO) {
        await api(`${base}/seo/${post!.id}`, 'PUT', seoInput);
        baselineSEO = seoSnapshot;
      }
      savedChange = startChange;
      recovered = null;
      if (!destroyed) {
        $('#editor-error').hidden = true;
        $('#document-status').textContent = statusText();
        $('#inspector-status').textContent = statusText();
        state(
          changed === savedChange ? 'Đã lưu' : 'Có thay đổi mới',
          changed === savedChange ? 'saved' : 'local',
        );
        $('#footer-save').textContent =
          'Lưu lúc ' +
          new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
      }
      localSave();
    });
  }
  function setSide(value: string) {
    main
      .querySelectorAll<HTMLElement>('[data-side]')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.side === value)));
    for (const p of ['post', 'seo', 'outline']) $('#panel-' + p).hidden = p !== value;
    $('.document-sidebar').classList.remove('closed');
    $('.editor-layout').classList.remove('sidebar-closed');
  }
  function listen(id: string, fn: () => unknown) {
    $(id).addEventListener('click', () => Promise.resolve().then(fn).catch(showError));
  }
  title.addEventListener('input', change);
  slug.addEventListener('input', () => {
    slugTouched = true;
    change();
  });
  excerpt.addEventListener('input', change);
  rich.on('change', () => queueMicrotask(change));
  for (const selector of [
    '#post-type',
    '#seo-title',
    '#seo-description',
    '#seo-canonical',
    '#seo-og',
    '#seo-schema',
    '#seo-noindex',
    '#seo-nofollow',
  ])
    $(selector).addEventListener('input', () => {
      if (selector === '#post-type')
        $('#document-kind').textContent =
          $<HTMLSelectElement>('#post-type').value === 'page' ? 'TRANG' : 'BÀI VIẾT';
      change();
    });
  main
    .querySelectorAll<HTMLElement>('[data-side]')
    .forEach((el) => (el.onclick = () => setSide(el.dataset.side!)));
  listen('#editor-settings', () => {
    $('.document-sidebar').classList.toggle('closed');
    $('.editor-layout').classList.toggle('sidebar-closed');
  });
  listen('#focus-mode', () => {
    focus = !focus;
    main.classList.toggle('focus-mode', focus);
    $('#focus-mode').setAttribute('aria-pressed', String(focus));
  });
  listen('#visual-mode', () => {
    rich.changeMode('wysiwyg', true);
    $('#visual-mode').classList.add('active');
    $('#markdown-mode').classList.remove('active');
    $('#visual-mode').setAttribute('aria-pressed', 'true');
    $('#markdown-mode').setAttribute('aria-pressed', 'false');
  });
  listen('#markdown-mode', () => {
    rich.changeMode('markdown', true);
    rich.changePreviewStyle('tab');
    $('#markdown-mode').classList.add('active');
    $('#visual-mode').classList.remove('active');
    $('#markdown-mode').setAttribute('aria-pressed', 'true');
    $('#visual-mode').setAttribute('aria-pressed', 'false');
  });
  listen('#editor-undo', () => rich.exec('undo'));
  listen('#editor-redo', () => rich.exec('redo'));
  $('#block-format').addEventListener('change', () => {
    const level = Number($<HTMLSelectElement>('#block-format').value);
    rich.exec(level ? 'heading' : 'paragraph', level ? { level } : {});
    rich.focus();
  });
  main.querySelectorAll<HTMLElement>('[data-format]').forEach((btn) => {
    btn.addEventListener('mousedown', (event) => event.preventDefault());
    btn.onclick = () => {
      const command = btn.dataset.format!;
      if (command === 'image') void mediaPicker(false).catch(showError);
      else if (command === 'link') linkDialog();
      else if (command === 'table') rich.exec('addTable', { rowCount: 3, columnCount: 3 });
      else rich.exec(command);
    };
  });
  listen('#save-post', () => save());
  if (can('content:publish')) listen('#publish', () => publishDialog());
  if ($('#unpublish'))
    listen('#unpublish', () =>
      confirmDialog(
        'Chuyển về bản nháp?',
        'Bài viết sẽ không còn xuất hiện công khai. Nội dung được giữ lại.',
        async () => {
          if (dirty()) await save(true);
          await api(`${base}/posts/${post!.id}/unpublish`, 'POST', {});
          post = await api(`${base}/posts/${post!.id}`);
          $('#document-status').textContent = statusText();
          $('#inspector-status').textContent = statusText();
          $('#publish span').textContent = 'Xuất bản';
          $('#save-post span').textContent = 'Lưu nháp';
          $('#unpublish-section').hidden = true;
          host.toast('Đã chuyển về bản nháp.');
        },
      ),
    );
  listen('#preview', preview);
  listen('#new-category', () => {
    const d = openDialog(
      'Thêm danh mục',
      `<form id="category-form"><label>Tên danh mục<input name="name" required maxlength="120" placeholder="Ví dụ: Cẩm nang"></label><label>Đường dẫn<input name="slug" placeholder="Tự tạo từ tên"></label><p class="dialog-error" role="alert"></p><div class="dialog-footer"><button type="button" data-close>Hủy</button><button class="primary">Thêm danh mục</button></div></form>`,
    );
    d.querySelector('form')!.onsubmit = async (event) => {
      event.preventDefault();
      const f = new FormData(event.currentTarget as HTMLFormElement);
      try {
        const c = await api(`${base}/categories`, 'POST', {
          name: f.get('name'),
          slug: f.get('slug') || slugify(String(f.get('name'))),
        });
        categories.push(c);
        initial.category_ids.push(c.id);
        renderCategories();
        change();
        d.close();
      } catch (error) {
        d.querySelector('.dialog-error')!.textContent = (error as Error).message;
      }
    };
  });
  listen('#load-suggestions', async () => {
    const rows: Post[] = await api(`${base}/posts?status=published&limit=100`);
    $('#link-suggestions').innerHTML =
      rows
        .filter((p) => p.id !== post?.id)
        .slice(0, 12)
        .map(
          (p) =>
            `<button class="suggestion-link" data-link-id="${p.id}">${icon('link')}<span>${e(p.title)}<small>/${e(p.slug)}</small></span></button>`,
        )
        .join('') || '<p class="field-hint">Chưa có bài viết khác đã xuất bản.</p>';
    $('#link-suggestions')
      .querySelectorAll<HTMLElement>('[data-link-id]')
      .forEach(
        (btn) =>
          (btn.onclick = () => {
            const p = rows.find((p) => p.id === btn.dataset.linkId)!;
            rich.exec('addLink', { linkUrl: '/' + p.slug, linkText: p.title });
            rich.focus();
          }),
      );
  });
  function renderCategories() {
    $('#category-checklist').innerHTML = categories.length
      ? categories
          .map(
            (c) =>
              `<label class="check-label"><input type="checkbox" value="${c.id}" ${initial.category_ids.includes(c.id) ? 'checked' : ''}> ${e(c.name)}</label>`,
          )
          .join('')
      : '<p class="field-hint">Chưa có danh mục. Thêm danh mục để nhóm bài viết.</p>';
    $('#category-checklist')
      .querySelectorAll('input')
      .forEach(
        (input) =>
          (input.onchange = () => {
            initial.category_ids = Array.from(
              $('#category-checklist').querySelectorAll<HTMLInputElement>('input:checked'),
            ).map((i) => i.value);
            change();
          }),
      );
  }
  function renderFeatured() {
    const m = media.find((m) => m.id === initial.featured_media);
    $('#featured-image').innerHTML = m
      ? `<button class="featured-preview" id="choose-featured" aria-label="Thay ảnh đại diện"><img src="/api/v1${base}/media/${m.id}/file" alt="${e(m.alt)}" width="${m.width}" height="${m.height}"></button><div class="featured-caption"><span>${e(m.filename)}</span><button id="remove-featured" class="text-button" aria-label="Bỏ ảnh đại diện">${icon('xmark')}</button></div>`
      : `<button class="featured-placeholder" id="choose-featured">${icon('image')}<strong>Chọn ảnh đại diện</strong><small>Tải lên hoặc chọn từ thư viện</small></button>`;
    listen('#choose-featured', () => mediaPicker(true));
    if (m)
      listen('#remove-featured', () => {
        initial.featured_media = null;
        renderFeatured();
        change();
      });
  }
  function openDialog(title: string, body: string, wide = false) {
    const d = document.querySelector<HTMLDialogElement>('#dialog')!;
    d.className = wide ? 'wide-dialog' : '';
    d.innerHTML = `<div class="dialog-heading"><h2>${e(title)}</h2><button type="button" class="icon-button" data-close aria-label="Đóng">${icon('xmark')}</button></div>${body}`;
    d.querySelectorAll<HTMLElement>('[data-close]').forEach((b) => (b.onclick = () => d.close()));
    d.showModal();
    return d;
  }
  function confirmDialog(title: string, text: string, action: () => Promise<void>) {
    const d = openDialog(
      title,
      `<p>${e(text)}</p><p class="dialog-error" role="alert"></p><div class="dialog-footer"><button data-close>Hủy</button><button class="primary" id="confirm-action">Xác nhận</button></div>`,
    );
    d.querySelector<HTMLButtonElement>('#confirm-action')!.onclick = async (event) => {
      const btn = event.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        await action();
        d.close();
      } catch (error) {
        d.querySelector('.dialog-error')!.textContent = (error as Error).message;
      } finally {
        btn.disabled = false;
      }
    };
  }
  async function uploadImage(blob: Blob | File, alt?: string): Promise<Media> {
    if (!can('media:write')) throw new Error('Tài khoản chưa được cấp quyền tải ảnh.');
    if (blob.size > 10 * 1024 * 1024) throw new Error('Ảnh tối đa 10 MB.');
    const file = blob instanceof File ? blob : new File([blob], 'image.png', { type: blob.type });
    const f = new FormData();
    f.set('file', file);
    f.set('alt', alt || file.name.replace(/\.[^.]+$/, ''));
    const m = await api(`${base}/media`, 'POST', f);
    media.unshift(m);
    return m;
  }
  async function mediaPicker(featured: boolean) {
    const d = openDialog(
      featured ? 'Chọn ảnh đại diện' : 'Chèn ảnh vào bài viết',
      `<div class="media-picker-toolbar"><label class="search-field">${icon('magnifying-glass')}<input id="media-search" type="search" placeholder="Tìm ảnh trong website này…" aria-label="Tìm ảnh"></label>${can('media:write') ? `<button type="button" id="picker-upload-button" class="primary">${icon('cloud-arrow-up')} Tải ảnh lên</button><input id="picker-upload" type="file" accept="image/png,image/jpeg,image/gif" hidden>` : ''}</div><p class="dialog-error" role="alert"></p><div class="picker-grid" id="picker-grid"></div><div class="picker-footer"><label>Mô tả ảnh (alt text)<input id="picker-alt" placeholder="Mô tả nội dung trong ảnh"></label><button id="insert-media" class="primary" disabled>${featured ? 'Đặt ảnh đại diện' : 'Chèn ảnh'}</button></div>`,
      true,
    );
    let selected: Media | null = null;
    const grid = d.querySelector('#picker-grid')!;
    const paint = () => {
      const q = (d.querySelector('#media-search') as HTMLInputElement).value.toLowerCase();
      const items = media.filter((m) => (m.filename + ' ' + m.alt).toLowerCase().includes(q));
      grid.innerHTML = items.length
        ? items
            .map(
              (m) =>
                `<button class="picker-item ${selected?.id === m.id ? 'selected' : ''}" data-media="${m.id}" aria-label="Chọn ${e(m.filename)}" aria-pressed="${selected?.id === m.id}"><img src="/api/v1${base}/media/${m.id}/file" width="${m.width}" height="${m.height}" alt="${e(m.alt)}" loading="lazy"><span>${e(m.filename)}</span></button>`,
            )
            .join('')
        : `<div class="picker-empty">${icon('images')}<h3>Thư viện đang trống</h3><p>Tải ảnh đầu tiên để minh họa cho câu chuyện.</p></div>`;
      grid.querySelectorAll<HTMLElement>('[data-media]').forEach(
        (btn) =>
          (btn.onclick = () => {
            selected = media.find((m) => m.id === btn.dataset.media)!;
            (d.querySelector('#picker-alt') as HTMLInputElement).value = selected.alt;
            (d.querySelector('#insert-media') as HTMLButtonElement).disabled = false;
            paint();
          }),
      );
    };
    paint();
    d.querySelector('#media-search')!.addEventListener('input', paint);
    const input = d.querySelector<HTMLInputElement>('#picker-upload');
    d.querySelector('#picker-upload-button')?.addEventListener('click', () => input?.click());
    if (input)
      input.onchange = async () => {
        if (!input.files?.[0]) return;
        input.disabled = true;
        try {
          selected = await uploadImage(input.files[0]);
          (d.querySelector('#picker-alt') as HTMLInputElement).value = selected.alt;
          (d.querySelector('#insert-media') as HTMLButtonElement).disabled = false;
          paint();
        } catch (error) {
          d.querySelector('.dialog-error')!.textContent = (error as Error).message;
        } finally {
          input.disabled = false;
        }
      };
    d.querySelector<HTMLButtonElement>('#insert-media')!.onclick = async () => {
      if (!selected) return;
      const alt = (d.querySelector('#picker-alt') as HTMLInputElement).value;
      try {
        if (can('media:write') && alt !== selected.alt) {
          await api(`${base}/media/${selected.id}`, 'PATCH', { alt });
          selected.alt = alt;
        }
        if (featured) {
          initial.featured_media = selected.id;
          renderFeatured();
          change();
        } else
          rich.exec('addImage', {
            imageUrl: `/api/v1${base}/media/${selected.id}/file`,
            altText: alt,
          });
        d.close();
        rich.focus();
      } catch (error) {
        d.querySelector('.dialog-error')!.textContent = (error as Error).message;
      }
    };
  }
  function linkDialog() {
    const selection = rich.getSelectedText();
    const d = openDialog(
      'Chèn liên kết',
      `<form><label>Văn bản hiển thị<input name="text" value="${e(selection)}" placeholder="Tên trang hoặc nội dung liên kết"></label><label>Đường dẫn<input name="url" placeholder="https://… hoặc /bai-viet" required></label><p class="dialog-error" role="alert"></p><div class="dialog-footer"><button type="button" data-close>Hủy</button><button class="primary">Chèn liên kết</button></div></form>`,
    );
    d.querySelector('form')!.onsubmit = (event) => {
      event.preventDefault();
      const f = new FormData(event.currentTarget as HTMLFormElement),
        url = String(f.get('url')).trim();
      if (!/^(https?:\/\/|mailto:|\/(?!\/)|#)/i.test(url) || url.includes('\\')) {
        d.querySelector('.dialog-error')!.textContent =
          'Dùng URL http(s), mailto hoặc đường dẫn bắt đầu bằng /.';
        return;
      }
      rich.exec('addLink', { linkUrl: url, linkText: String(f.get('text')) || url });
      d.close();
      rich.focus();
    };
  }
  async function preview() {
    const data = getData();
    const response = await fetch('/api/v1' + base + '/preview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({
        ...(post ? { post_id: post.id } : {}),
        post: {
          ...data,
          title: data.title || 'Bài viết chưa có tiêu đề',
          slug: data.slug || 'ban-xem-truoc',
        },
        ...(can('seo:read') ? { seo: seoPayload() } : {}),
      }),
    });
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error?.message || 'Không tạo được bản xem trước.');
    }
    const html = await response.text();
    const d = openDialog(
      'Xem trước website',
      `<div class="preview-controls"><div class="segmented"><button class="active" data-device="desktop">${icon('desktop')} Máy tính</button><button data-device="mobile">${icon('mobile-screen')} Điện thoại</button></div><span>Bản xem trước chưa xuất bản</span></div><div class="preview-canvas"><iframe id="preview-frame" title="Xem trước bài viết" sandbox="allow-same-origin"></iframe></div>`,
      true,
    );
    const frame = d.querySelector<HTMLIFrameElement>('iframe')!;
    frame.srcdoc = html;
    d.querySelectorAll<HTMLElement>('[data-device]').forEach(
      (btn) =>
        (btn.onclick = () => {
          d.querySelectorAll('[data-device]').forEach((b) => b.classList.remove('active'));
          btn.classList.add('active');
          frame.classList.toggle('mobile-preview', btn.dataset.device === 'mobile');
        }),
    );
  }
  function publishDialog() {
    const data = getData();
    if (!data.title) {
      title.focus();
      throw new Error('Thêm tiêu đề để tiếp tục.');
    }
    const existing = post?.status === 'published' || post?.status === 'scheduled';
    const warnings = [
      !data.markdown_content.trim() ? 'Nội dung bài viết đang trống.' : '',
      !data.excerpt && !$<HTMLTextAreaElement>('#seo-description').value
        ? 'Chưa có mô tả cho bài viết.'
        : '',
      !data.featured_media ? 'Chưa chọn ảnh đại diện.' : '',
      site.status !== 'active' ? 'Website chưa hoạt động; bài chưa thể xem công khai.' : '',
      site.robots_mode !== 'index'
        ? 'Website đang noindex; công cụ tìm kiếm chưa lập chỉ mục.'
        : '',
      post?.published_at && post.slug !== data.slug
        ? 'Đổi đường dẫn sẽ tạo redirect 301 từ URL cũ.'
        : '',
    ].filter(Boolean);
    const d = openDialog(
      existing ? 'Cập nhật bài viết?' : 'Sẵn sàng xuất bản?',
      `<div class="publish-summary">${icon('paper-plane')}<strong>${e(data.title)}</strong><small>${e(site.primary_domain)}/${e(data.slug)}</small></div><div class="publish-checks"><p>${icon('check')} Website: <strong>${e(site.name)}</strong></p><p>${icon('check')} ${readingStats(data.markdown_content).words} từ · ${data.category_ids.length} danh mục</p>${warnings.map((w) => `<p class="check-warning">${icon('circle-info')} ${e(w)}</p>`).join('')}</div>${!existing ? `<label>Thời điểm xuất bản<select id="publish-when"><option value="now">Ngay bây giờ</option><option value="schedule">Lên lịch</option></select></label><label id="schedule-field" hidden>Ngày và giờ<input id="schedule-date" type="datetime-local"><small>Theo múi giờ thiết bị: ${e(Intl.DateTimeFormat().resolvedOptions().timeZone)}. Lịch chạy mỗi 5 phút.</small></label>` : ''}<p class="dialog-error" role="alert"></p><div class="dialog-footer"><button data-close>Kiểm tra thêm</button><button id="confirm-publish" class="primary">${existing ? 'Cập nhật' : 'Xuất bản'}</button></div>`,
    );
    d.querySelector('#publish-when')?.addEventListener('change', () => {
      d.querySelector<HTMLElement>('#schedule-field')!.hidden =
        (d.querySelector('#publish-when') as HTMLSelectElement).value !== 'schedule';
    });
    d.querySelector<HTMLButtonElement>('#confirm-publish')!.onclick = async (event) => {
      const btn = event.currentTarget as HTMLButtonElement;
      btn.disabled = true;
      try {
        let scheduled_at: string | undefined;
        if ((d.querySelector('#publish-when') as HTMLSelectElement)?.value === 'schedule') {
          const value = (d.querySelector('#schedule-date') as HTMLInputElement).value;
          if (!value || Date.parse(value) <= Date.now())
            throw new Error('Chọn thời gian trong tương lai.');
          scheduled_at = new Date(value).toISOString();
        }
        await save(true);
        if (!existing)
          post = await api(`${base}/posts/${post!.id}/publish`, 'POST', {
            version: post!.version,
            ...(scheduled_at ? { scheduled_at } : {}),
          });
        $('#document-status').textContent = statusText();
        $('#inspector-status').textContent = statusText();
        $('#publish span').textContent = 'Cập nhật';
        $('#unpublish-section').hidden = false;
        $('#save-post span').textContent = 'Lưu trên máy';
        state('Đã lưu');
        d.close();
        host.toast(
          scheduled_at
            ? 'Đã lên lịch xuất bản.'
            : existing
              ? 'Đã cập nhật bài viết.'
              : 'Đã xuất bản bài viết.',
        );
      } catch (error) {
        d.querySelector('.dialog-error')!.textContent = (error as Error).message;
        showError(error);
      } finally {
        btn.disabled = false;
      }
    };
  }
  function applyRecovery() {
    if (!recovered) return;
    initial = { ...initial, ...recovered.post };
    title.value = initial.title;
    slug.value = initial.slug;
    slugTouched = !!initial.slug;
    excerpt.value = initial.excerpt;
    $<HTMLSelectElement>('#post-type').value = initial.type;
    rich.setMarkdown(contentToEditor(initial.markdown_content, site.id));
    const r = recovered.seo || {};
    for (const [key, selector] of [
      ['seo_title', '#seo-title'],
      ['description', '#seo-description'],
      ['canonical_override', '#seo-canonical'],
      ['og_image', '#seo-og'],
      ['schema_type', '#seo-schema'],
    ])
      $<HTMLInputElement>(selector).value = r[key] || '';
    $<HTMLInputElement>('#seo-noindex').checked = !!r.noindex;
    $<HTMLInputElement>('#seo-nofollow').checked = !!r.nofollow;
    renderCategories();
    renderFeatured();
    $('#recovery-notice').innerHTML = '';
    recovered = null;
    change();
  }
  renderCategories();
  renderFeatured();
  updateReadouts();
  // Normalize the visual editor's Markdown representation before tracking edits.
  baselinePost = JSON.stringify(getData());
  if (
    recovered &&
    (JSON.stringify(recovered.post) !== baselinePost ||
      JSON.stringify(recovered.seo) !== baselineSEO)
  ) {
    $('#recovery-notice').innerHTML =
      `<div class="recovery-notice">${icon('clock-rotate-left')}<span>Có bản chỉnh sửa trên máy từ ${e(new Date(recovered.time).toLocaleString('vi-VN'))}${recovered.version !== post?.version && post ? ' · bản trên máy chủ đã thay đổi. Hãy xem lại trước khi lưu.' : '.'}</span><button id="restore-draft">Khôi phục</button><button id="ignore-draft" class="text-button">Bỏ bản trên máy</button></div>`;
    listen('#restore-draft', applyRecovery);
    listen('#ignore-draft', () => {
      localStorage.removeItem(recoveryKey);
      recovered = null;
      $('#recovery-notice').innerHTML = '';
    });
  }
  const keyboard = (event: KeyboardEvent) => {
    if (document.querySelector<HTMLDialogElement>('#dialog')?.open) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void save().catch(showError);
    }
    if (event.key === 'Escape' && focus) {
      focus = false;
      main.classList.remove('focus-mode');
    }
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (dirty()) {
      localSave();
      event.preventDefault();
      event.returnValue = '';
    }
  };
  window.addEventListener('keydown', keyboard);
  window.addEventListener('beforeunload', unload);
  return {
    destroy() {
      if (destroyed) return;
      localSave();
      destroyed = true;
      clearTimeout(timer);
      rich.destroy();
      main.classList.remove('editor-main-surface');
      window.removeEventListener('keydown', keyboard);
      window.removeEventListener('beforeunload', unload);
    },
    async beforeLeave() {
      clearTimeout(timer);
      await queue.run(async () => {});
      if (!dirty()) return true;
      localSave();
      return new Promise((resolve) => {
        const d = openDialog(
          'Rời trình biên tập?',
          `<p>Nội dung đang chỉnh sửa đã được giữ trên máy này.</p><p class="dialog-error" role="alert"></p><div class="dialog-footer"><button id="stay-editor">Tiếp tục viết</button><button id="leave-local">Rời đi, giữ bản trên máy</button>${post?.status !== 'published' && post?.status !== 'scheduled' ? '<button id="save-leave" class="primary">Lưu nháp và rời đi</button>' : ''}</div>`,
        );
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          d.close();
          resolve(value);
        };
        d.addEventListener(
          'close',
          () => {
            if (!settled) {
              settled = true;
              resolve(false);
            }
          },
          { once: true },
        );
        d.querySelector('#stay-editor')!.addEventListener('click', () => finish(false));
        d.querySelector('#leave-local')!.addEventListener('click', () => finish(true));
        d.querySelector('#save-leave')?.addEventListener('click', async () => {
          try {
            await save();
            finish(true);
          } catch (error) {
            d.querySelector('.dialog-error')!.textContent = (error as Error).message;
          }
        });
      });
    },
  };
}
