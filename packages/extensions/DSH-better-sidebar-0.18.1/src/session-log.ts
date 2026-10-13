/**
 * Cross-generation read of a live session's event log.
 *
 * DSH 0.1.2-alpha.4 renamed the `Session.events` property to the
 * `snapshotEvents()` method; hosts before that rename (0.1.2-alpha.1 …
 * alpha.3, which is what the desktop harness ships) only expose the
 * property. Both faces hand back the SAME thing — an immutable snapshot of
 * the append-only log, reused until the next append invalidates it — so the
 * host routes here stay agnostic: prefer the method when the host has it,
 * fall back to the property otherwise.
 *
 * Returns `undefined` for an absent session or an unreadable log, so a
 * caller that wants an empty window keeps writing `?? []` and a caller that
 * wants the persistence fallback keeps testing for `undefined`.
 */
import type { SidebarSessionEvent } from './context-types.ts'

export function sessionLogEvents<T = SidebarSessionEvent>(session: unknown): readonly T[] | undefined {
  if (session === undefined || session === null) return undefined
  const holder = session as {
    snapshotEvents?: () => readonly T[]
    events?: readonly T[]
  }
  if (typeof holder.snapshotEvents === 'function') {
    try {
      return holder.snapshotEvents()
    } catch {
      // A host that exposes the method but throws (session mid-teardown)
      // reads as "no log", never as a route-level failure.
      return undefined
    }
  }
  return Array.isArray(holder.events) ? holder.events : undefined
}
