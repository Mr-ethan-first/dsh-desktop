import { Service } from '@deepseek-ai/cordis'
/**
 * Service implementation discovered independently of its protocol package.
 * @typert service
 */
export class DetachedService extends Service {
  /** Report readiness. */
  ready(): boolean { return true }
}
