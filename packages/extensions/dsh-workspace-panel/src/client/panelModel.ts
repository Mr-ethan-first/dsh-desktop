/**
 * Pure state model for the workspace right panel. No DOM, no React, no cordis
 * — a thin, unit-testable core the React shell wraps. Keeping this out of the
 * components means adding a future pane type (e.g. terminal, JSON viewer) only
 * touches the registry below, never the preview/file-tree logic.
 */

export type PreviewKind = 'markdown' | 'html' | 'code' | 'image' | 'unknown'

/** A file-preview tab: shows one file from the workspace tree. */
export interface FileTab {
  readonly id: string
  readonly type: 'file'
  readonly relPath: string
  readonly name: string
  content: string
  kind: PreviewKind
  loading: boolean
  error?: string
}

/** A built-in browser tab: the reserved extension point for future surfaces. */
export interface BrowserTab {
  readonly id: string
  readonly type: 'browser'
  url: string
}

export type Tab = FileTab | BrowserTab

/** Stable id for a file tab (one tab per file path — re-open focuses, never duplicates). */
export function fileTabId(relPath: string): string {
  return `file:${relPath}`
}

let browserSeq = 0
/** Stable-ish id for a browser tab (multiple browser tabs allowed). */
export function browserTabId(): string {
  browserSeq += 1
  return `browser:${browserSeq}`
}

/** Basename of a path using both separators. */
export function basenameOf(relPath: string): string {
  const norm = relPath.replace(/\\/g, '/')
  const idx = norm.lastIndexOf('/')
  return idx >= 0 ? norm.slice(idx + 1) : norm
}

/** Infer preview kind from a file extension. */
export function detectKind(relPath: string): PreviewKind {
  const lower = relPath.toLowerCase()
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'html'
  if (
    lower.endsWith('.png') || lower.endsWith('.jpg') || lower.endsWith('.jpeg') ||
    lower.endsWith('.gif') || lower.endsWith('.svg') || lower.endsWith('.webp') ||
    lower.endsWith('.bmp')
  ) return 'image'
  if (
    lower.endsWith('.ts') || lower.endsWith('.tsx') || lower.endsWith('.js') ||
    lower.endsWith('.jsx') || lower.endsWith('.json') || lower.endsWith('.css') ||
    lower.endsWith('.scss') || lower.endsWith('.yml') || lower.endsWith('.yaml') ||
    lower.endsWith('.txt') || lower.endsWith('.py') || lower.endsWith('.go') ||
    lower.endsWith('.rs') || lower.endsWith('.java') || lower.endsWith('.c') ||
    lower.endsWith('.cpp') || lower.endsWith('.sh')
  ) return 'code'
  return 'unknown'
}

/**
 * Upsert a file tab: focus it if already open, otherwise append. Returns the
 * next tab list and the active id (always the upserted tab).
 */
export function upsertFileTab(
  tabs: readonly Tab[],
  relPath: string,
  kind: PreviewKind,
): { tabs: Tab[]; activeId: string } {
  const id = fileTabId(relPath)
  const existing = tabs.find((t) => t.id === id)
  if (existing) return { tabs: [...tabs], activeId: id }
  const tab: FileTab = {
    id,
    type: 'file',
    relPath,
    name: basenameOf(relPath),
    content: '',
    kind,
    loading: true,
  }
  return { tabs: [...tabs, tab], activeId: id }
}

/** Patch one tab by id (content/loading/error/url). Returns a new list. */
export function updateTab(tabs: readonly Tab[], id: string, patch: Partial<Tab>): Tab[] {
  return tabs.map((t) => (t.id === id ? ({ ...t, ...patch } as Tab) : t))
}

/**
 * Close a tab. Returns the next list and the id that should become active:
 * the neighbor of the closed tab (previous wins), or undefined when none left.
 */
export function closeTab(tabs: readonly Tab[], activeId: string | null, id: string): {
  tabs: Tab[]
  activeId: string | null
} {
  const idx = tabs.findIndex((t) => t.id === id)
  if (idx < 0) return { tabs: [...tabs], activeId }
  const next = tabs.filter((t) => t.id !== id)
  if (activeId !== id) return { tabs: next, activeId }
  if (next.length === 0) return { tabs: next, activeId: null }
  const neighbor = next[Math.max(0, idx - 1)]
  return neighbor === undefined
    ? { tabs: next, activeId: null }
    : { tabs: next, activeId: neighbor.id }
}

/** Drop every file tab, keep browser tabs. Used when the workspace root changes. */
export function filterOutFileTabs(tabs: readonly Tab[]): Tab[] {
  return tabs.filter((t) => t.type !== 'file')
}
