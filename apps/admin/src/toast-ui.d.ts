// Upstream 3.2.2 exports omit their declaration entry under Bundler resolution.
declare module '@toast-ui/editor' {
  const Editor: typeof import('../../../node_modules/@toast-ui/editor/types/editor').Editor;
  export default Editor;
}
