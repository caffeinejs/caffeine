import type { CallAdapter } from '../call_adapter.js'
import { CallbackCallAdapter } from '../callback/index.js'
import { Accept } from '../decorators/accept.js'
import { API } from '../decorators/api.js'
import { ContentType } from '../decorators/content_type.js'
import { FormURLEncoded } from '../decorators/form_url_encoded.js'
import { HeaderMap } from '../decorators/header_map.js'
import { Multipart } from '../decorators/multipart.js'
import { Params } from '../decorators/params.js'
import { Field } from '../decorators/params/field.js'
import { Part } from '../decorators/params/part.js'
import { RawResponse } from '../decorators/raw_response.js'
import { Retry } from '../decorators/retry.js'
import { POST } from '../decorators/verbs.js'

/**
 * An operation may be declared as a field as well as a method, and every decorator that accepts a member has
 * to accept both. A field decorator is called with `undefined` where a method decorator is called with the
 * function, so a decorator typing that parameter as `Function` is rejected on a field with `TS1240` — which
 * nothing at run time can catch, since the call never happens. `npm run test:typecheck` is the test.
 */

@API('/token')
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
@API('/token')
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

// @Multipart() takes the same three positions as @FormURLEncoded().
@API('/documents')
@Multipart()
class MultipartAPI {
  @POST('/field')
  @Multipart()
  @Params([Part('title')])
  field!: (title: string) => Promise<unknown>

  @POST('/method')
  @Multipart()
  @Params([Part('title')])
  method(_title: string): Promise<unknown> {
    return Promise.resolve()
  }
}

void [FieldDeclaredAPI, MethodDeclaredAPI, ClassDeclaredAPI, MultipartAPI]

// A call adapter's result is what a call to the operation runs, so it has to be a function.
const callbackAdapter: CallAdapter = CallbackCallAdapter.INSTANCE
// @ts-expect-error a number is not a call shape
const numberAdapter: CallAdapter<number> = { adapt: () => 42 }

void [callbackAdapter, numberAdapter]
