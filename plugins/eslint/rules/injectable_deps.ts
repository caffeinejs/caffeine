import type { Rule } from 'eslint'

const DECORATORS = new Set(['Injectable', 'Configuration'])

function getDepsArray(callExpr: any): any {
  const args = callExpr.arguments
  if (args.length === 0) {
    return null
  }
  if (args[0].type === 'ArrayExpression') {
    return args[0]
  }
  if (args.length >= 2 && args[1].type === 'ArrayExpression') {
    return args[1]
  }
  return null
}

export const injectableDeps: Rule.RuleModule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require @Injectable() and @Configuration() to declare a deps array when the constructor has parameters',
      recommended: true,
    },
    schema: [],
    messages: {
      missingDeps:
        '@{{decoratorName}}() on "{{className}}" has {{paramCount}} constructor parameter(s) but no dependencies array declared.',
      depsCountMismatch:
        '@{{decoratorName}}() on "{{className}}" declares {{depsCount}} dependency(ies) but the constructor has {{paramCount}} parameter(s).',
    },
  },

  create(context: Rule.RuleContext) {
    function checkClass(node: any) {
      const decorators = node.decorators ?? []

      for (const decorator of decorators) {
        const expr = decorator.expression
        if (expr.type !== 'CallExpression') {
          continue
        }

        const callee = expr.callee
        const decoratorName = callee.type === 'Identifier' ? callee.name : null
        if (!decoratorName || !DECORATORS.has(decoratorName)) {
          continue
        }

        const ctor = node.body.body.find(
          (member: any) => member.type === 'MethodDefinition' && member.kind === 'constructor',
        )

        const paramCount = ctor ? ctor.value.params.length : 0
        if (paramCount === 0) {
          continue
        }

        const className = node.id?.name ?? '<anonymous>'
        const depsArray = getDepsArray(expr)

        if (depsArray === null) {
          context.report({
            node: decorator,
            messageId: 'missingDeps',
            data: { decoratorName, className, paramCount },
          })
        } else if (depsArray.elements.length !== paramCount) {
          context.report({
            node: decorator,
            messageId: 'depsCountMismatch',
            data: { decoratorName, className, depsCount: depsArray.elements.length, paramCount },
          })
        }
      }
    }

    return {
      ClassDeclaration: checkClass,
      ClassExpression: checkClass,
    }
  },
}
