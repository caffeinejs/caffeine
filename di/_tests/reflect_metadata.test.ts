import { describe, it, expect } from 'vitest'

import { token } from '../key.js'
import { defineMetadata, getMetadata, getMetadataOverride, reflect } from '../reflect.js'

const kRoles = token<any>(Symbol('roles'))
const kTitle = token<any>(Symbol('title'))

function Roles(...roles: string[]) {
  return (_target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
    defineMetadata(context, kRoles, roles)
  }
}

function Title(title: string) {
  return (_target: unknown, context: ClassDecoratorContext | ClassMemberDecoratorContext) => {
    defineMetadata(context, kTitle, title)
  }
}

describe('defineMetadata / getMetadata', function () {
  @Roles('admin')
  @Title('users')
  class Users {
    @Roles('editor')
    edit() {}

    list() {}
  }

  it('returns the class slot', function () {
    expect(getMetadata<string[]>(Users, kRoles)).toEqual(['admin'])
    expect(getMetadata<string>(Users, kTitle)).toBe('users')
  })

  it('returns the member slot without falling back to the class', function () {
    expect(getMetadata<string[]>(Users, kRoles, 'edit')).toEqual(['editor'])
    expect(getMetadata<string[]>(Users, kRoles, 'list')).toBeUndefined()
  })

  it('returns undefined when the key is absent', function () {
    const kMissing = token<any>(Symbol('missing'))
    expect(getMetadata(Users, kMissing)).toBeUndefined()
    expect(getMetadata(Users, kMissing, 'edit')).toBeUndefined()
  })

  it('returns undefined for a class with no Symbol.metadata slot', function () {
    class Bare {}
    expect(getMetadata(Bare, kRoles)).toBeUndefined()
  })

  it('two symbols on the same class do not collide', function () {
    expect(getMetadata<string[]>(Users, kRoles)).toEqual(['admin'])
    expect(getMetadata<string>(Users, kTitle)).toBe('users')
  })

  it('is also available on reflect', function () {
    expect(reflect.getMetadata<string[]>(Users, kRoles)).toEqual(['admin'])
    expect(reflect.getMetadataOverride<string[]>(Users, kRoles, 'edit')).toEqual(['editor'])
  })
})

describe('getMetadataOverride', function () {
  @Roles('admin')
  class AdminCtrl {
    @Roles('superadmin')
    delete() {}

    list() {}
  }

  it('prefers the member slot', function () {
    expect(getMetadataOverride<string[]>(AdminCtrl, kRoles, 'delete')).toEqual(['superadmin'])
  })

  it('falls back to the class slot', function () {
    expect(getMetadataOverride<string[]>(AdminCtrl, kRoles, 'list')).toEqual(['admin'])
  })

  it('returns undefined when neither slot is set', function () {
    class Plain {
      run() {}
    }
    expect(getMetadataOverride(Plain, kRoles, 'run')).toBeUndefined()
  })
})
