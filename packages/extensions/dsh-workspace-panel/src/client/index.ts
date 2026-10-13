/**
 * Workspace panel plugin, browser half. Mounts a collapsible right-side panel
 * into the `shell.overlay` slot — the frame-wide additive layer — so the panel
 * docks on the right without touching the official three-column layout
 * (sidebar | conversation | details). Adding a future surface (terminal, JSON
 * viewer) means registering one more tab type in panelModel.ts, never editing
 * the layout kernel.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { WorkspacePanel } from './WorkspacePanel.tsx'

/**
 * The `slots` service is provided by the UI renderer at runtime (it augments
 * `Context` with `slots: SlotRegistry`). We cannot import the renderer's
 * `/client` types here: its published `lib/types/client/index.d.ts` self-imports
 * `./registry.ts`, which only exists as `src` in this tree, so a type import
 * would drag the renderer's source into this package's program. Instead we
 * declare the slice of the `SlotRegistry` shape this plugin actually uses.
 * Runtime behavior is unchanged — `ctx.slots` is the real registry.
 */
interface SlotRegistryLike {
  inject(name: string, factory: () => unknown): () => void
  register(
    options: { name: string; id: string; locale?: string; inject?: unknown },
    component: unknown,
  ): unknown
}
declare module '@deepseek-ai/cordis' {
  interface Context {
    slots: SlotRegistryLike
  }
}

/** Required services (cordis fiber inject — the loader passes module exports as an object plugin). */
export const inject = ['slots']

/** Mount the panel into the frame-wide overlay layer. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'workspace-panel' },
      WorkspacePanel,
    ),
  ), 'workspace-panel: shell.overlay mount')
}
