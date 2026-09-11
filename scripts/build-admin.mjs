import { build } from 'esbuild';
import { mkdir, copyFile, cp } from 'node:fs/promises';
await mkdir('dist/admin/admin', { recursive: true });
await build({
  entryPoints: ['apps/admin/src/main.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  outdir: 'dist/admin/admin',
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  splitting: true,
  target: 'es2022',
});
await copyFile('apps/admin/public/index.html', 'dist/admin/admin/index.html');
await copyFile('apps/admin/src/style.css', 'dist/admin/admin/style.css');

await mkdir('dist/admin/admin/vendor', { recursive: true });
await copyFile(
  'node_modules/@toast-ui/editor/dist/toastui-editor.css',
  'dist/admin/admin/vendor/editor.css',
);
await copyFile(
  'node_modules/@fortawesome/fontawesome-free/css/all.min.css',
  'dist/admin/admin/vendor/fontawesome.css',
);
await cp('node_modules/@fortawesome/fontawesome-free/webfonts', 'dist/admin/admin/webfonts', {
  recursive: true,
});
await copyFile(
  'node_modules/@fortawesome/fontawesome-free/LICENSE.txt',
  'dist/admin/admin/vendor/fontawesome-LICENSE.txt',
);
