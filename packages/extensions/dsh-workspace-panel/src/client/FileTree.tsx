import { useState } from 'react'
import css from './panel.module.css'

/** A node in the workspace directory tree (shape matches the host `readDirectory` bridge). */
export interface TreeNode {
  id: string
  name: string
  type: 'file' | 'dir'
  path: string
  children?: TreeNode[]
}

interface FileTreeProps {
  nodes: TreeNode[]
  depth: number
  onOpenFile: (relPath: string) => void
  onExpand: (dirPath: string) => Promise<TreeNode[]>
}

/** Recursive, lazily-expanded directory tree. Dirs fetch their children on first expand. */
export function FileTree({ nodes, depth, onOpenFile, onExpand }: FileTreeProps): React.ReactNode {
  return (
    <ul className={css.treeList} style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {nodes.map((node) => (
        <TreeRow key={node.id} node={node} depth={depth} onOpenFile={onOpenFile} onExpand={onExpand} />
      ))}
    </ul>
  )
}

function TreeRow({
  node,
  depth,
  onOpenFile,
  onExpand,
}: {
  node: TreeNode
  depth: number
  onOpenFile: (relPath: string) => void
  onExpand: (dirPath: string) => Promise<TreeNode[]>
}): React.ReactNode {
  const [expanded, setExpanded] = useState(false)
  const [children, setChildren] = useState<TreeNode[] | null>(node.children ?? null)
  const [loading, setLoading] = useState(false)

  const isDir = node.type === 'dir'

  const toggle = async () => {
    if (!isDir) {
      onOpenFile(node.path)
      return
    }
    if (!expanded && children === null) {
      setLoading(true)
      try {
        const next = await onExpand(node.path)
        setChildren(next)
      } catch {
        setChildren([])
      } finally {
        setLoading(false)
      }
    }
    setExpanded((v) => !v)
  }

  return (
    <li className={css.treeRow}>
      <div
        className={css.treeNode}
        style={{ paddingLeft: depth * 12 }}
        onClick={toggle}
        title={node.path}
      >
        <span className={css.treeIcon}>{isDir ? (expanded ? '📂' : '📁') : '📄'}</span>
        <span className={css.treeName}>{node.name}</span>
        {loading && <span className={css.muted}>…</span>}
      </div>
      {isDir && expanded && children !== null && (
        <FileTree nodes={children} depth={depth + 1} onOpenFile={onOpenFile} onExpand={onExpand} />
      )}
    </li>
  )
}
