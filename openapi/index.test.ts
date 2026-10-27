import { describe, expect, it } from 'vitest'

import * as api from './index.js'

// The package entry is what an application imports. Pinning its runtime exports makes adding or dropping one a
// deliberate change, reviewed here, rather than a side effect of editing a barrel.
describe('@caffeinejs/openapi', () => {
  it('exports exactly its public runtime surface', () => {
    expect(Object.keys(api).sort()).toEqual([
      'APIGroup',
      'ComponentRegistry',
      'DEFAULT_OPENAPI_VERSION',
      'ErrOpenAPIConfiguration',
      'ErrOpenAPIOperationConflict',
      'ErrOpenAPISchemaConflict',
      'OpenAPIOptionsBuilder',
      'OpenAPISecurityBuilder',
      'Operation',
      'apiGroup',
      'authorizationNote',
      'buildSecuritySchemes',
      'componentName',
      'defaultOpenAPIOptions',
      'defaultOperationId',
      'deriveParameters',
      'deriveRequestBody',
      'deriveResponses',
      'deriveSecurity',
      'generateDocument',
      'joinPaths',
      'kBuild',
      'openapi',
      'operation',
      'operationSite',
      'readScalarBundle',
      'routeURL',
      'routerBaseName',
      'scalarPage',
      'templateParameters',
      'toRouteAuthz',
      'toSecurityScheme',
      'translatePath',
      'validateDocument',
    ])
  })
})
