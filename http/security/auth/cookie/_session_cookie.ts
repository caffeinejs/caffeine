import { openJWT, sealJWT, unsealJWT, type OpenedJWT, type SealingSecrets } from '../internal/sealed_jwt.js'

// The cookie scheme's session token: what it is called, and which key it is sealed under. The key is derived per
// scheme name, so two cookie schemes sharing one secret cannot open each other's sessions.
const PURPOSE = 'session+jwt'

const info = (scheme: string) => `caffeine:cookie:${PURPOSE}:${scheme}`

export function sealSession(
  payload: Record<string, unknown>,
  secret: SealingSecrets,
  scheme: string,
  ttlSeconds: number,
): Promise<string> {
  return sealJWT(payload, PURPOSE, secret, info(scheme), ttlSeconds)
}

export function unsealSession<T>(cookie: string, secret: SealingSecrets, scheme: string): Promise<T> {
  return unsealJWT<T>(cookie, PURPOSE, secret, info(scheme))
}

export function openSession<T>(cookie: string, secret: SealingSecrets, scheme: string): Promise<OpenedJWT<T>> {
  return openJWT<T>(cookie, PURPOSE, secret, info(scheme))
}
