import { describe, it, expect } from 'vitest';
import { normalizeHost, safeURL } from '../packages/shared/src/index';
import { renderMarkdown, internalLinks } from '../packages/content/src/index';
import { delta, period } from '../packages/analytics/src/index';
import { matchesTarget } from '../packages/themes/src/index';
import { imageInfo } from '../packages/domain/src/media';
import { passwordHash, verifyPassword } from '../packages/auth/src/index';
describe('security and pure domain behavior', () => {
  it('normalizes hosts without trusting URL syntax', () => {
    expect(normalizeHost('EXAMPLE.COM.:443')).toBe('example.com');
    expect(() => normalizeHost('a.com/b.com')).toThrow();
    expect(() => normalizeHost('a@b.com')).toThrow();
  });
  it('rejects script URLs and protocol-relative URLs', () => {
    for (const value of ['javascript:alert(1)', '//evil.com', '/\\evil.com', 'http://evil.com'])
      expect(() => safeURL(value)).toThrow();
    expect(safeURL('/article')).toBe('/article');
  });
  it('sanitizes Markdown with heading IDs and no raw HTML execution', () => {
    const { html, headings } = renderMarkdown(
      '## Hello\n\n## Hello\n\n<script>alert(1)</script>\n\n[x](javascript:alert(1))\n\n![image](https://example.com/image.png)',
    );
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript:');
    expect(headings.map((h) => h.id)).toEqual(['hello', 'hello-1']);
    expect(html).toContain('loading="lazy"');
  });
  it('extracts internal links only from the current tenant', () => {
    expect(
      internalLinks('[one](/one) [two](https://a.com/two#x) [other](https://b.com/three)', 'a.com'),
    ).toEqual(['/one', '/two']);
  });
  it('reports absolute and percent deltas without infinity', () => {
    expect(delta(100, 80)).toEqual({ absolute: 20, percent: 25 });
    expect(delta(30, 0)).toEqual({ absolute: 30, percent: null });
    expect(period('2026-09-01', '2026-09-07')).toEqual({
      start: '2026-09-01',
      end: '2026-09-07',
      previousStart: '2026-08-25',
      previousEnd: '2026-08-31',
    });
    expect(() => period('2026-02-30', '2026-03-01')).toThrow();
  });
  it('handles include/exclude targeting without regex injection', () => {
    expect(
      matchesTarget(
        { kinds: ['posts'], include: ['/blog*'], exclude: ['/blog-private'] },
        'posts',
        '/blog-one',
      ),
    ).toBe(true);
    expect(matchesTarget({ exclude: ['/blog*'] }, 'posts', '/blog-one')).toBe(false);
    expect(matchesTarget({ include: ['/a.b'] }, 'pages', '/axb')).toBe(false);
  });
  it('rejects disguised SVG uploads', () => {
    expect(() => imageInfo(new TextEncoder().encode('<svg onload="alert(1)"></svg>'))).toThrow();
  });
  it('hashes passwords with salt', async () => {
    const stored = await passwordHash('correct-password');
    expect(stored).not.toContain('correct-password');
    expect(await verifyPassword('correct-password', stored)).toBe(true);
    expect(await verifyPassword('wrong-password', stored)).toBe(false);
  });
});
