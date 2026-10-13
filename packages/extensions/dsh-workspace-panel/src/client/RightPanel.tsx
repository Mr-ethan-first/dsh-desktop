import { useEffect, useState } from 'react'
import type { Tab } from './panelModel.ts'
import css from './panel.module.css'

interface RightPanelProps {
  tabs: Tab[]
  activeId: string | null
  onClose: (id: string) => void
  onActivate: (id: string) => void
  onOpenBrowser: () => void
  onUpdateBrowser: (id: string, url: string) => void
  onOpenInExplorer: (relPath: string) => void
  basenameOf: (relPath: string) => string
}

/** Tab strip + active content. The browser tab is the reserved extension point for future surfaces. */
export function RightPanel({
  tabs,
  activeId,
  onClose,
  onActivate,
  onOpenBrowser,
  onUpdateBrowser,
  onOpenInExplorer,
  basenameOf,
}: RightPanelProps): React.ReactNode {
  const active = tabs.find((t) => t.id === activeId) ?? null

  if (tabs.length === 0) {
    return (
      <div className={css.rightPane}>
        <div className={css.tabsBar}>
          <button className={css.addBrowser} title="打开内置浏览器" onClick={onOpenBrowser}>＋ 🌐</button>
        </div>
        <div className={css.empty}>
          <div className={css.emptyIcon}>👁</div>
          <div>从左侧文件树选择文件以预览</div>
          <div className={css.muted}>多文件会以标签页形式在此并排展示</div>
        </div>
      </div>
    )
  }

  return (
    <div className={css.rightPane}>
      <div className={css.tabsBar}>
        <div className={css.tabs}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={t.id === activeId ? `${css.tab} ${css.tabActive}` : css.tab}
              onClick={() => onActivate(t.id)}
              data-active={t.id === activeId || undefined}
              title={t.type === 'file' ? t.relPath : t.url}
            >
              <span className={css.tabIcon}>{t.type === 'file' ? iconFor(t.kind) : '🌐'}</span>
              <span className={css.tabName}>{t.type === 'file' ? t.name : '浏览器'}</span>
              <span
                className={css.tabClose}
                role="button"
                aria-label="关闭"
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(t.id)
                }}
              >×</span>
            </button>
          ))}
        </div>
        <button className={css.addBrowser} title="打开内置浏览器" onClick={onOpenBrowser}>＋ 🌐</button>
      </div>
      {active && <ActiveContent
        tab={active}
        basenameOf={basenameOf}
        onOpenInExplorer={onOpenInExplorer}
        onUpdateBrowser={onUpdateBrowser}
      />}
    </div>
  )
}

function iconFor(kind: string): string {
  switch (kind) {
    case 'markdown': return '📝'
    case 'html': return '🌐'
    case 'code': return '💻'
    case 'image': return '🖼'
    default: return '📄'
  }
}

function ActiveContent({
  tab,
  basenameOf,
  onOpenInExplorer,
  onUpdateBrowser,
}: {
  tab: Tab
  basenameOf: (relPath: string) => string
  onOpenInExplorer: (relPath: string) => void
  onUpdateBrowser: (id: string, url: string) => void
}): React.ReactNode {
  if (tab.type === 'browser') {
    return <BrowserView tab={tab} onUpdateBrowser={onUpdateBrowser} />
  }
  const file = tab
  return (
    <div className={css.content}>
      <div className={css.contentHeader}>
        <span className={css.contentName} title={file.relPath}>{basenameOf(file.relPath)}</span>
        <button
          className={css.iconBtn}
          title="在资源管理器中打开"
          onClick={() => onOpenInExplorer(file.relPath)}
        >📂 定位</button>
      </div>
      {file.loading && <div className={css.muted}>加载中…</div>}
      {!file.loading && file.error && <pre className={css.errorBox}>{file.error}</pre>}
      {!file.loading && !file.error && file.kind === 'html' && (
        <iframe className={css.frame} title={file.relPath} sandbox="allow-scripts allow-same-origin" srcDoc={file.content} />
      )}
      {!file.loading && !file.error && file.kind === 'image' && (
        <div className={css.muted}>图片文件请在本地直接打开（预览仅支持文本/HTML）。</div>
      )}
      {!file.loading && !file.error && (file.kind === 'markdown' || file.kind === 'code' || file.kind === 'unknown') && (
        <pre className={css.pre}>{file.content}</pre>
      )}
    </div>
  )
}

function BrowserView({
  tab,
  onUpdateBrowser,
}: {
  tab: Extract<Tab, { type: 'browser' }>
  onUpdateBrowser: (id: string, url: string) => void
}): React.ReactNode {
  const [addr, setAddr] = useState(tab.url)
  // Keep the input in sync when switching to a different browser tab.
  useEffect(() => { setAddr(tab.url) }, [tab.url])
  return (
    <div className={css.content}>
      <div className={css.addrBar}>
        <input
          className={css.addrInput}
          value={addr}
          onChange={(e) => setAddr(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') onUpdateBrowser(tab.id, addr) }}
          placeholder="https://"
        />
        <button className={css.primaryBtn} onClick={() => onUpdateBrowser(tab.id, addr)}>前往</button>
      </div>
      <iframe className={css.frame} title="browser" src={tab.url} sandbox="allow-scripts allow-same-origin allow-forms" />
    </div>
  )
}
