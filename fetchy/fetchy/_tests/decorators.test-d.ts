import { Accept } from '../decorators/accept.js'
import { API } from '../decorators/api.js'
import { ContentType } from '../decorators/content_type.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Params } from '../decorators/params.js'
import { Field } from '../decorators/params/field.js'
import { Path } from '../decorators/path.js'
import { RawResponse } from '../decorators/raw_response.js'
import { Retry } from '../decorators/retry.js'
import { POST } from '../decorators/verbs.js'

/**
 * An operation may be declared as a field as well as a method, and every decorator that accepts a member has
 * to accept both. A field decorator is called with `undefined` where a method decorator is called with the
 * function, so a decorator typing that parameter as `Function` is rejected on a field with `TS1240` — which
 * nothing at run time can catch, since the call never happens. `npm run test:typecheck` is the test.
 */

@API()
@Path('/token')
class FieldDeclaredAPI {
  @POST('/')
  @FormURLEncoded()
  @Params([Field('grant_type')])
  token!: (grantType: string) => Promise<unknown>

  @POST('/json')
  @ContentType('application/json')
  @Params([Field('name')])
  create!: (name: string) => Promise<unknown>

  @POST('/accept')
  @Accept('application/json')
  @Params([Field('name')])
  accepts!: (name: string) => Promise<unknown>

  @POST('/headers')
  @HeaderMap({ 'x-trace': 'on' })
  @Params([Field('name')])
  headers!: (name: string) => Promise<unknown>

  @POST('/retry')
  @Retry({ limit: 2 })
  @Params([Field('name')])
  retries!: (name: string) => Promise<unknown>

  @POST('/raw')
  @RawResponse()
  @Params([Field('name')])
  raw!: (name: string) => Promise<Response>
}

// The same decorators on a method, which already worked, so the fix does not trade one position for the other.
@API()
@Path('/token')
class MethodDeclaredAPI {
  @POST('/')
  @FormURLEncoded()
  @Params([Field('grant_type')])
  token(_grantType: string): Promise<unknown> {
    return Promise.resolve()
  }

  @POST('/json')
  @ContentType('application/json')
  @Params([Field('name')])
  create(_name: string): Promise<unknown> {
    return Promise.resolve()
  }
}

// And at class level, the position `classOrMember` exists to serve alongside the member one.
@API()
@ContentType('application/json')
@FormURLEncoded()
@Accept('application/json')
class ClassDeclaredAPI {}

void [FieldDeclaredAPI, MethodDeclaredAPI, ClassDeclaredAPI]
