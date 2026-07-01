import { describe, it } from 'vitest'
import { RuleTester } from 'eslint'
import { parser as tsParser } from 'typescript-eslint'
import { injectableDeps } from './injectable_deps.js'

RuleTester.describe = describe as typeof RuleTester.describe
RuleTester.it = it as typeof RuleTester.it

const tester = new RuleTester({
  languageOptions: {
    parser: tsParser as never,
  },
})

tester.run('injectable-deps', injectableDeps, {
  valid: [
    // no constructor at all
    {
      code: `@Injectable() class A {}`,
    },
    // constructor with no params
    {
      code: `@Injectable() class A { constructor() {} }`,
    },
    // deps array matches 1 param
    {
      code: `@Injectable([Dep]) class A { constructor(d: Dep) {} }`,
    },
    // key + deps array matches 1 param
    {
      code: `@Injectable(key, [Dep]) class A { constructor(d: Dep) {} }`,
    },
    // deps array matches 2 params
    {
      code: `@Injectable([Dep1, Dep2]) class A { constructor(a: Dep1, b: Dep2) {} }`,
    },
    // @Configuration with deps array
    {
      code: `@Configuration([Dep]) class A { constructor(d: Dep) {} }`,
    },
    // @Configuration with config object + deps array
    {
      code: `@Configuration({ lazy: true }, [Dep]) class A { constructor(d: Dep) {} }`,
    },
    // unrelated decorator — should not trigger
    {
      code: `@Lifetime(Scopes.SINGLETON) class A { constructor(d: Dep) {} }`,
    },
    // @Injectable with no params, unrelated class with params
    {
      code: `@Injectable() class A {} class B { constructor(d: Dep) {} }`,
    },
    // class expression with deps matching params
    {
      code: `const A = @Injectable([Dep]) class { constructor(d: Dep) {} }`,
    },
  ],

  invalid: [
    // constructor has param, no deps array at all
    {
      code: `@Injectable() class A { constructor(d: Dep) {} }`,
      errors: [{ messageId: 'missingDeps', data: { decoratorName: 'Injectable', className: 'A', paramCount: 1 } }],
    },
    // key only, no deps array
    {
      code: `@Injectable('svc') class A { constructor(d: Dep) {} }`,
      errors: [{ messageId: 'missingDeps', data: { decoratorName: 'Injectable', className: 'A', paramCount: 1 } }],
    },
    // symbol key, no deps array
    {
      code: `const k = Symbol(); @Injectable(k) class A { constructor(d: Dep) {} }`,
      errors: [{ messageId: 'missingDeps', data: { decoratorName: 'Injectable', className: 'A', paramCount: 1 } }],
    },
    // empty deps array but constructor has param
    {
      code: `@Injectable([]) class A { constructor(d: Dep) {} }`,
      errors: [
        {
          messageId: 'depsCountMismatch',
          data: { decoratorName: 'Injectable', className: 'A', depsCount: 0, paramCount: 1 },
        },
      ],
    },
    // 1 dep but 2 params
    {
      code: `@Injectable([Dep]) class A { constructor(a: Dep, b: Dep2) {} }`,
      errors: [
        {
          messageId: 'depsCountMismatch',
          data: { decoratorName: 'Injectable', className: 'A', depsCount: 1, paramCount: 2 },
        },
      ],
    },
    // 2 deps but 1 param
    {
      code: `@Injectable([Dep1, Dep2]) class A { constructor(a: Dep1) {} }`,
      errors: [
        {
          messageId: 'depsCountMismatch',
          data: { decoratorName: 'Injectable', className: 'A', depsCount: 2, paramCount: 1 },
        },
      ],
    },
    // @Configuration with no deps array
    {
      code: `@Configuration() class A { constructor(d: Dep) {} }`,
      errors: [{ messageId: 'missingDeps', data: { decoratorName: 'Configuration', className: 'A', paramCount: 1 } }],
    },
    // @Configuration with config object but no deps
    {
      code: `@Configuration({ lazy: true }) class A { constructor(d: Dep) {} }`,
      errors: [{ messageId: 'missingDeps', data: { decoratorName: 'Configuration', className: 'A', paramCount: 1 } }],
    },
    // @Configuration deps count mismatch
    {
      code: `@Configuration([Dep]) class A { constructor(a: Dep, b: Dep2) {} }`,
      errors: [
        {
          messageId: 'depsCountMismatch',
          data: { decoratorName: 'Configuration', className: 'A', depsCount: 1, paramCount: 2 },
        },
      ],
    },
    // anonymous class expression — className falls back to <anonymous>
    {
      code: `const A = @Injectable() class { constructor(d: Dep) {} }`,
      errors: [
        { messageId: 'missingDeps', data: { decoratorName: 'Injectable', className: '<anonymous>', paramCount: 1 } },
      ],
    },
  ],
})
