/**
 * Test-only helper to read a class's `context.metadata` token from outside decorator scope,
 * without touching `Symbol.metadata` (fetchy's production code never reads that well-known
 * symbol — see `decorators/registrar/registrar.ts`). Apply `capture` as an extra decorator
 * anywhere on the class being tested, then call `metadata()` once the class has been declared.
 */
export function captureMetadata(): {
  capture: (_target: unknown, context: ClassDecoratorContext) => void
  metadata: () => object
} {
  let captured: object | undefined

  return {
    capture(_target: unknown, context: ClassDecoratorContext): void {
      captured = context.metadata
    },
    metadata(): object {
      if (!captured) {
        throw new Error('captureMetadata: the capture decorator was never applied to a class')
      }

      return captured
    },
  }
}
