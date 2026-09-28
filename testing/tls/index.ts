import type { FastifyServerSettings } from '@caffeinejs/http'

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
 * Configures a loopback HTTPS server on an OS-assigned port for tests.
 *
 * Return the settings from an `app.server(...)` callback. The certificate and private key are fixed and bundled
 * with this package; use them only for local tests. Trust the server in a client with {@link testTLSCertificate}.
 *
 * @example
 * createWebApplication().server(() => testTLS())
 */
export function testTLS(): FastifyServerSettings {
  return {
    factory: { https: { key, cert: certificate } },
    listener: { host: '127.0.0.1', port: 0 },
  }
}

/** Returns the PEM certificate used by {@link testTLS}, suitable for a test client's `ca` option. */
export function testTLSCertificate(): string {
  return certificate
}
