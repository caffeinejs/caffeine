import { ResolutionContext } from './resolution_context.js'

/**
 * PostProcessor defines a contract for a post-processor implementation.
 */
export interface PostProcessor {
  /**
   * Called before the instance is initialized.
   */
  beforeInit(ctx: ResolutionContext, instance: unknown): unknown

  /**
   * Called after the instance is initialized.
   */
  afterInit(ctx: ResolutionContext, instance: unknown): unknown
}
