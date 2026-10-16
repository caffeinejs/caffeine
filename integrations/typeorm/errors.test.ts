import { DataSource, type EntityTarget, type ObjectLiteral } from 'typeorm'
import { describe, expect, it } from 'vitest'

import { UserEntity } from './_testdata/entities.testkit.js'
import { ErrNoDataSource } from './errors.js'

class Invoice {}

describe('ErrNoDataSource', function () {
  // TypeORM takes an entity in four shapes, and the name is how a reader finds which of several repositories is
  // unwired. A schema and a { type, name } object are both objects: only the schema keeps its name under `options`.
  it.each([
    ['an entity schema', UserEntity, 'User'],
    ['a class', Invoice, 'Invoice'],
    ['a table name', 'invoices', 'invoices'],
    ['a { type, name } object', { type: {}, name: 'Invoice' }, 'Invoice'],
  ] as [string, EntityTarget<ObjectLiteral>, string][])(
    'should name an entity given as %s',
    function (_shape, target, name) {
      expect(new ErrNoDataSource(DataSource, target).message).toContain(`a repository for "${name}"`)
    },
  )

  it('should not mistake a missing key for one named "undefined"', function () {
    expect(new ErrNoDataSource(undefined, UserEntity).message).toContain('bound to the key "(undefined)"')
  })
})
