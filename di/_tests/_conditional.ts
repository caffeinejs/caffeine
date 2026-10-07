import { $cond } from '../conditional.js'
import { token } from '../key.js'

// Nothing binds this key, so a condition on it is decided the same way in every container.
export const kUnbound = token<string>(Symbol('never bound'))

/** A condition that always passes, for a test that only needs a binding held until the container compiles. */
export const always = $cond.missing(kUnbound)

/** A condition that never passes. */
export const never = $cond.present(kUnbound)
