/** Public detached Service protocol. */
export interface DetachedProtocol {
  /** Report protocol readiness. */
  ready(): boolean
}
declare module '@deepseek-ai/cordis' {
  interface Context { detached: DetachedProtocol }
}
