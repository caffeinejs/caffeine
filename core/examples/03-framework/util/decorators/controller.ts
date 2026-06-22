import { Injection } from '@caffeine/core'
import { composeDecorators, Injectable, Label, Tag } from '@caffeine/core/decorators'

export function Controller(path: string, dependencies?: Injection[]) {
  return composeDecorators(
    Injectable(dependencies ?? []),
    Label(Symbol.for('controller')),
    Tag(Symbol.for('controller:base'), path),
  )
}
