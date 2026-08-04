import { SignJWT } from 'jose'

export const JWT_SECRET = process.env.PETSTORE_JWT_SECRET ?? 'petstore-dev-secret'

const secret = new TextEncoder().encode(JWT_SECRET)

/**
 * Mints an HS256 JWT with the given subject and roles. The `roles` claim is what caffeine's JWT
 * bearer strategy reads (roleClaimType defaults to 'roles'), so `@Roles(...)`
 * gates on the scopes embedded here.
 */
export async function signToken(sub: string, roles: string[]): Promise<string> {
  return new SignJWT({ roles })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret)
}
