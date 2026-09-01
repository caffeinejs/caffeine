import { defineClassOrMemberDecorator } from './_decorator_util.js'
import { configureRoute, configureRouteGroup } from './registrar/registrar.js'

export function Header(name: string, value: string | string[], charset?: string) {
  const finalValue = charset === undefined ? value : appendCharset(value, charset)

  return defineClassOrMemberDecorator(
    (target, ctx) => configureRouteGroup(ctx, target, spec => spec.header(name, finalValue)),
    context => configureRoute(context, spec => spec.header(name, finalValue)),
  )
}

function appendCharset(value: string | string[], charset: string): string | string[] {
  return Array.isArray(value)
    ? value.map(v => `${v}; charset=${charset}`)
    : `${value}; charset=${charset}`
}

// Header names attached to the decorator,
// so `Header` doubles as a container for header names: `@Header(Header.CACHE_CONTROL, 'no-store')`.

// Content / representation
Header.CONTENT_TYPE = 'Content-Type'
Header.CONTENT_LENGTH = 'Content-Length'
Header.CONTENT_ENCODING = 'Content-Encoding'
Header.CONTENT_LANGUAGE = 'Content-Language'
Header.CONTENT_DISPOSITION = 'Content-Disposition'
Header.CONTENT_LOCATION = 'Content-Location'
Header.CONTENT_RANGE = 'Content-Range'

// Content negotiation
Header.ACCEPT = 'Accept'
Header.ACCEPT_ENCODING = 'Accept-Encoding'
Header.ACCEPT_LANGUAGE = 'Accept-Language'
Header.ACCEPT_RANGES = 'Accept-Ranges'

// Caching / conditional
Header.CACHE_CONTROL = 'Cache-Control'
Header.AGE = 'Age'
Header.EXPIRES = 'Expires'
Header.PRAGMA = 'Pragma'
Header.VARY = 'Vary'
Header.ETAG = 'ETag'
Header.LAST_MODIFIED = 'Last-Modified'
Header.IF_MATCH = 'If-Match'
Header.IF_NONE_MATCH = 'If-None-Match'
Header.IF_MODIFIED_SINCE = 'If-Modified-Since'
Header.IF_UNMODIFIED_SINCE = 'If-Unmodified-Since'
Header.IF_RANGE = 'If-Range'
Header.RANGE = 'Range'
Header.RETRY_AFTER = 'Retry-After'

// Authentication
Header.AUTHORIZATION = 'Authorization'
Header.WWW_AUTHENTICATE = 'WWW-Authenticate'
Header.PROXY_AUTHORIZATION = 'Proxy-Authorization'
Header.PROXY_AUTHENTICATE = 'Proxy-Authenticate'

// Cookies
Header.COOKIE = 'Cookie'
Header.SET_COOKIE = 'Set-Cookie'

// CORS
Header.ORIGIN = 'Origin'
Header.ACCESS_CONTROL_ALLOW_ORIGIN = 'Access-Control-Allow-Origin'
Header.ACCESS_CONTROL_ALLOW_METHODS = 'Access-Control-Allow-Methods'
Header.ACCESS_CONTROL_ALLOW_HEADERS = 'Access-Control-Allow-Headers'
Header.ACCESS_CONTROL_ALLOW_CREDENTIALS = 'Access-Control-Allow-Credentials'
Header.ACCESS_CONTROL_EXPOSE_HEADERS = 'Access-Control-Expose-Headers'
Header.ACCESS_CONTROL_MAX_AGE = 'Access-Control-Max-Age'
Header.ACCESS_CONTROL_REQUEST_METHOD = 'Access-Control-Request-Method'
Header.ACCESS_CONTROL_REQUEST_HEADERS = 'Access-Control-Request-Headers'

// Request context / general
Header.HOST = 'Host'
Header.REFERER = 'Referer'
Header.USER_AGENT = 'User-Agent'
Header.DATE = 'Date'
Header.LOCATION = 'Location'
Header.LINK = 'Link'
Header.ALLOW = 'Allow'
Header.SERVER = 'Server'

// Connection
Header.CONNECTION = 'Connection'
Header.KEEP_ALIVE = 'Keep-Alive'
Header.UPGRADE = 'Upgrade'
Header.TRANSFER_ENCODING = 'Transfer-Encoding'
Header.TE = 'TE'
Header.TRAILER = 'Trailer'

// Forwarding
Header.FORWARDED = 'Forwarded'
Header.X_FORWARDED_FOR = 'X-Forwarded-For'
Header.X_FORWARDED_HOST = 'X-Forwarded-Host'
Header.X_FORWARDED_PROTO = 'X-Forwarded-Proto'

// Security
Header.STRICT_TRANSPORT_SECURITY = 'Strict-Transport-Security'
Header.CONTENT_SECURITY_POLICY = 'Content-Security-Policy'
Header.X_CONTENT_TYPE_OPTIONS = 'X-Content-Type-Options'
Header.X_FRAME_OPTIONS = 'X-Frame-Options'
Header.X_XSS_PROTECTION = 'X-XSS-Protection'
Header.REFERRER_POLICY = 'Referrer-Policy'

// Common non-standard
Header.X_REQUEST_ID = 'X-Request-ID'
Header.X_CORRELATION_ID = 'X-Correlation-ID'
Header.X_REQUESTED_WITH = 'X-Requested-With'
Header.X_POWERED_BY = 'X-Powered-By'
Header.DNT = 'DNT'
