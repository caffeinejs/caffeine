import { ErrCaffeine } from '../../error.js'

/**
 * A guard key that cannot be used: nothing is bound to it, or what is bound has no `guard` method. Detected
 * when the guards are compiled at start-up, so it rejects `ready()` rather than failing every request.
 */
export class ErrGuardConfiguration extends ErrCaffeine {
  constructor(message: string, ...solutions: string[]) {
    super(message, 'ERR_GUARD_CONFIGURATION', undefined, ...solutions)
  }
}
