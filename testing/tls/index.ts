import fixture from './_testdata/localhost.json' with { type: 'json' }

// This fixed TLS identity is deliberately public test data, not an application credential. Never use it for a
// deployed server. Its certificate lets clients verify local HTTPS without disabling TLS checks.
// Generation options (LibreSSL 3.3.6): openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650
//   -set_serial 0x01 -subj '/CN=localhost'
//   -addext 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1'
// The randomly generated, unencrypted key and self-signed X.509 v3 certificate are bundled in _testdata.
// Subject and issuer: CN=localhost. SANs: DNS localhost; IP 127.0.0.1 and ::1. Serial: 01.
// Validity: 2026-09-28 17:30:21 UTC to 2036-09-25 17:30:21 UTC.
// SHA-256 fingerprint: 31:4C:6F:69:41:47:B7:C2:E1:9B:F0:FD:99:93:1F:6C:FA:CF:5E:76:9B:4B:15:6C:E1:53:E1:50:32:B2:0E:2E.
const { key, certificate } = fixture

/**
 * Returns the fixed TLS identity for a loopback HTTPS server in tests.
 *
 * The private key and certificate are bundled with this package and cover `localhost`, `127.0.0.1` and `::1`; use
 * them only for local tests. Trust the server in a client with {@link testTLSCertificate}.
 *
 * @example
 * createServer(testTLS(), handler).listen(0, '127.0.0.1') // node:https
 */
export function testTLS(): { key: string; cert: string } {
  return { key, cert: certificate }
}

/** Returns the PEM certificate used by {@link testTLS}, suitable for a test client's `ca` option. */
export function testTLSCertificate(): string {
  return certificate
}
