/** Compare meaningful user choices, not transient metadata or rendered controls. */
export function editorSnapshot(items = []) {
  return JSON.stringify(items.map(item => ({
    source: item.file ? `file:${item.key}` : `asset:${item.id || ''}`,
    duration: item.kind === 'video' ? null : Number(item.duration),
  })));
}
export function editorHasChanges(editor) {
  return Boolean(editor && editorSnapshot(editor.items) !== editor.baseline);
}
