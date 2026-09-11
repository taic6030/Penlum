import { describe, it, expect } from 'vitest';
import {
  slugify,
  contentToEditor,
  contentFromEditor,
  readingStats,
  SaveQueue,
} from '../apps/admin/src/ui';

describe('editor content persistence', () => {
  it('creates stable Vietnamese URLs and trims the cut-off separator', () => {
    expect(slugify('  Đưa nội dung ra ánh sáng! ')).toBe('dua-noi-dung-ra-anh-sang');
    expect(slugify('a'.repeat(159) + ' b')).toBe('a'.repeat(159));
    expect(slugify('   ')).toBe('');
  });
  it('round-trips tenant media without rewriting other tenants or external URLs', () => {
    const md =
      '![Ảnh](/media/abc-123)\n![Outside](https://example.com/media/abc-123)\n[Link](/hello)';
    const visual = contentToEditor(md, 'site-a');
    expect(visual).toContain('](/api/v1/sites/site-a/media/abc-123/file)');
    expect(contentFromEditor(visual, 'site-a')).toBe(md);
    const titled = '![Ảnh](/media/abc-123 "Một hình ảnh")';
    expect(contentFromEditor(contentToEditor(titled, 'site-a'), 'site-a')).toBe(titled);
    const literal = 'Tài liệu: /api/v1/sites/site-a/media/abc-123/file';
    expect(contentFromEditor(literal, 'site-a')).toBe(literal);
    expect(contentFromEditor('![B](/api/v1/sites/site-b/media/abc/file)', 'site-a')).toBe(
      '![B](/api/v1/sites/site-b/media/abc/file)',
    );
  });
  it('does not count image alt text as reading time', () => {
    expect(readingStats('## Xin chào\n\n![alt with many words](/media/x)').words).toBe(2);
    expect(readingStats('')).toEqual({ words: 0, minutes: 1 });
  });
  it('serializes rapid saves and still accepts a retry after a failed write', async () => {
    const queue = new SaveQueue(),
      versions: number[] = [];
    let version = 1,
      release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = queue.run(async () => {
      versions.push(version);
      await gate;
      version++;
    });
    const second = queue.run(async () => {
      versions.push(version);
      version++;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(versions).toEqual([1]);
    release();
    await Promise.all([first, second]);
    expect(versions).toEqual([1, 2]);
    await expect(
      queue.run(async () => {
        throw new Error('Offline');
      }),
    ).rejects.toThrow('Offline');
    await queue.run(async () => {
      versions.push(version);
    });
    expect(versions).toEqual([1, 2, 3]);
  });
});
