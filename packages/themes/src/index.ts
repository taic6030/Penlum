export const themes = {
  journal: {
    name: 'Journal',
    font: 'Georgia,serif',
    width: '760px',
    accent: '#185a50',
    background: '#fbfcfa',
  },
  editorial: {
    name: 'Editorial',
    font: 'Georgia,serif',
    width: '860px',
    accent: '#1d4293',
    background: '#fff',
  },
  minimal: {
    name: 'Minimal',
    font: 'system-ui,sans-serif',
    width: '720px',
    accent: '#292929',
    background: '#fff',
  },
} as const;
export type PageKind = 'home' | 'posts' | 'pages' | 'categories' | '404';
export interface Snippet {
  id: string;
  site_id: string | null;
  placement: string;
  targeting: string;
  priority: number;
  enabled: number;
  executable: number;
  content: string;
}
export function matchesTarget(
  target: { kinds?: string[]; include?: string[]; exclude?: string[] },
  kind: PageKind,
  path: string,
) {
  const matches = (pattern: string) =>
    new RegExp(
      '^' +
        pattern
          .split('*')
          .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
          .join('.*') +
        '$',
    ).test(path);
  if (target.kinds?.length && !target.kinds.includes(kind)) return false;
  if (target.exclude?.some(matches)) return false;
  return !target.include?.length || target.include.some(matches);
}
