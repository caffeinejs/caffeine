import { token } from '@caffeinejs/di'

import type { JWTService } from './jwt_service.js'

/**
 * Stable DI token for a JWT scheme's shared {@link JWTService}, keyed by scheme name. The default JWT
 * scheme is also bound under the bare `JWTService` class token for the common single-scheme case;
 * additional named schemes are reachable only through this key.
 */
export const jwtServiceKey = (name: string) => token<JWTService>(Symbol.for(`caffeinejs.jwt.service.${name}`))
