import { useCallback, useEffect, useRef, useState } from 'react'
import { FileTree, type TreeNode } from './FileTree.tsx'
import { RightPanel } from './RightPanel.tsx'
import {
  basenameOf,
  browserTabId,
  closeTab,
  detectKind,
  filterOutFileTabs,
  upsertFileTab,
  updateTab,
  type Tab,
} from './panelModel.ts'
import css from './panel.module.css'

/** Minimal shape of the Electron bridge the panel depends on (injected by the host preload). */
interface ElectronAPI {
  readDirectory: (dir: string) => Promise<TreeNode[]>
  fsOp: (
    kind: 'read' | 'write' | 'delete' | 'list',
    workDir: string,
    relPath: string,
    content?: string,
  ) => Promise<{ ok: boolean; text?: string; message?: string }>
  openFolder: (path: string) => Promise<void> | void
  selectDirectory: () => Promise<string | undefined>
}
declare global {
  interface Window {
    electronAPI?: ElectronAPI
  }
}

const ROOT_KEY = 'dsh-workspace-panel.root'

function joinPath(base: string, rel: string): string {
  const b = base.replace(/\\/g, '/').replace(/\/$/, '')
  const r = rel.replace(/\\/g, '/')
  return `${b}/${r}`
}

/** Collapsible right-docked workspace panel. */
export function WorkspacePanel(_props: object): React.ReactNode {
  const [open, setOpen] = useState(false)
  const [root, setRoot] = useState<string>(() => {
    try {
      return window.localStorage.getItem(ROOT_KEY) ?? ''
    } catch {
      return ''
    }
  })
  const [tree, setTree] = useState<TreeNode[] | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [tabs, setTabs] = useState<Tab[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const loadSeq = useRef(0)

  const loadTree = useCallback(async (dir: string): Promise<TreeNode[]> => {
    const api = window.electronAPI
    if (!api || !dir) {
      setTree(null)
      return []
    }
    const seq = ++loadSeq.current
    setTreeLoading(true)
    try {
      const nodes = await api.readDirectory(dir)
      if (seq === loadSeq.current) setTree(nodes)
      return nodes
    } catch (e) {
      if (seq === loadSeq.current) setTree([])
      return []
    } finally {
      if (seq === loadSeq.current) setTreeLoading(false)
    }
  }, [])

  useEffect(() => {
    if (open && root) void loadTree(root)
  }, [open, root, loadTree])

  const pickDirectory = useCallback(async () => {
    const api = window.electronAPI
    if (!api) return
    const picked = await api.selectDirectory()
    if (!picked) return
    try {
      window.localStorage.setItem(ROOT_KEY, picked)
    } catch { /* ignore quota */ }
    setRoot(picked)
    // Workspace root changed: cached file tabs no longer resolve — drop them.
    setTabs((prev) => filterOutFileTabs(prev))
    setActiveId((prev) => (prev && prev.startsWith('browser:') ? prev : null))
    void loadTree(picked)
  }, [loadTree])

  const openFile = useCallback(async (relPath: string) => {
    if (!root) return
    const kind = detectKind(relPath)
    const { tabs: nextTabs, activeId: nextActive } = upsertFileTab(tabs, relPath, kind)
    setTabs(nextTabs)
    setActiveId(nextActive)
    const api = window.electronAPI
    if (!api) return
    try {
      const r = await api.fsOp('read', root, relPath)
      if (r?.ok) {
        setTabs((prev) => updateTab(prev, nextActive, { content: r.text ?? '', loading: false, error: '' }))
      } else {
        setTabs((prev) => updateTab(prev, nextActive, {
          content: '',
          loading: false,
          error: r?.message || '读取失败',
        }))
      }
    } catch (e) {
      setTabs((prev) => updateTab(prev, nextActive, {
        content: '',
        loading: false,
        error: String((e as Error)?.message ?? e),
      }))
    }
  }, [root, tabs])

  const closeTabAt = useCallback((id: string) => {
    setTabs((prev) => {
      const { tabs: next, activeId: nextActive } = closeTab(prev, activeId, id)
      setActiveId(nextActive)
      return next
    })
  }, [activeId])

  const openBrowser = useCallback(() => {
    const tab = { id: browserTabId(), type: 'browser' as const, url: 'https://www.bing.com' }
    setTabs((prev) => [...prev, tab])
    setActiveId(tab.id)
  }, [])

  const updateBrowserUrl = useCallback((id: string, url: string) => {
    setTabs((prev) => updateTab(prev, id, { url }))
  }, [])

  const openInExplorer = useCallback((relPath: string) => {
    const api = window.electronAPI
    if (!api || !root) return
    void api.openFolder(joinPath(root, relPath))
  }, [root])

  const openRootInExplorer = useCallback(() => {
    const api = window.electronAPI
    if (!api || !root) return
    void api.openFolder(root)
  }, [root])

  if (!open) {
    return (
      <button
        className={css.edgeBtn}
        title="打开工作区面板"
        onClick={() => setOpen(true)}
      >
        📁
      </button>
    )
  }

  return (
    <section className={css.root} data-shell-overlay-panel>
      <header className={css.header}>
        <span className={css.title}>工作区</span>
        <div className={css.headerActions}>
          <button className={css.iconBtn} title="选择工作目录" onClick={pickDirectory}>📂</button>
          {root && (
            <button className={css.iconBtn} title="在资源管理器打开目录" onClick={openRootInExplorer}>🗂</button>
          )}
          <button className={css.iconBtn} title="收起" onClick={() => setOpen(false)}>✕</button>
        </div>
      </header>
      <div className={css.body}>
        <div className={css.treePane}>
          {!root && (
            <div className={css.empty}>
              <div>尚未选择工作目录</div>
              <button className={css.primaryBtn} onClick={pickDirectory}>选择目录</button>
            </div>
          )}
          {root && treeLoading && <div className={css.muted}>加载中…</div>}
          {root && !treeLoading && tree && (
            <FileTree nodes={tree} depth={0} onOpenFile={openFile} onExpand={loadTree} />
          )}
          {root && !treeLoading && tree && tree.length === 0 && (
            <div className={css.muted}>目录为空</div>
          )}
        </div>
        <RightPanel
          tabs={tabs}
          activeId={activeId}
          onClose={closeTabAt}
          onActivate={setActiveId}
          onOpenBrowser={openBrowser}
          onUpdateBrowser={updateBrowserUrl}
          onOpenInExplorer={openInExplorer}
          basenameOf={basenameOf}
        />
      </div>
    </section>
  )
}
