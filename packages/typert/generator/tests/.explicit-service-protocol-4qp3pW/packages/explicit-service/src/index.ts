import { Service } from '@deepseek-ai/cordis'
export type { DetachedProtocol } from './types.ts'
/**
 * Service implementation discovered independently of its protocol package.
 * @typert service detached
 */
export class DetachedService extends Service {
  /** Report readiness. */
  ready(): boolean { return true }
}
