import { ValueErrorType } from '@sinclair/typebox/errors'

// The JSON Schema keyword each TypeBox error checks, so an issue names the rule broken as Ajv names it: `minLength`,
// `required`, `format`. A kind JSON Schema has no keyword for (a `BigInt`, a `Date`) is a `type` mismatch.
const KEYWORDS: Partial<Record<ValueErrorType, string>> = {
  [ValueErrorType.ArrayContains]: 'contains',
  [ValueErrorType.ArrayMaxContains]: 'maxContains',
  [ValueErrorType.ArrayMaxItems]: 'maxItems',
  [ValueErrorType.ArrayMinContains]: 'minContains',
  [ValueErrorType.ArrayMinItems]: 'minItems',
  [ValueErrorType.ArrayUniqueItems]: 'uniqueItems',
  [ValueErrorType.IntegerExclusiveMaximum]: 'exclusiveMaximum',
  [ValueErrorType.IntegerExclusiveMinimum]: 'exclusiveMinimum',
  [ValueErrorType.IntegerMaximum]: 'maximum',
  [ValueErrorType.IntegerMinimum]: 'minimum',
  [ValueErrorType.IntegerMultipleOf]: 'multipleOf',
  [ValueErrorType.NumberExclusiveMaximum]: 'exclusiveMaximum',
  [ValueErrorType.NumberExclusiveMinimum]: 'exclusiveMinimum',
  [ValueErrorType.NumberMaximum]: 'maximum',
  [ValueErrorType.NumberMinimum]: 'minimum',
  [ValueErrorType.NumberMultipleOf]: 'multipleOf',
  [ValueErrorType.StringMaxLength]: 'maxLength',
  [ValueErrorType.StringMinLength]: 'minLength',
  [ValueErrorType.StringPattern]: 'pattern',
  [ValueErrorType.StringFormat]: 'format',
  [ValueErrorType.StringFormatUnknown]: 'format',
  [ValueErrorType.ObjectAdditionalProperties]: 'additionalProperties',
  [ValueErrorType.ObjectMaxProperties]: 'maxProperties',
  [ValueErrorType.ObjectMinProperties]: 'minProperties',
  [ValueErrorType.ObjectRequiredProperty]: 'required',
  [ValueErrorType.Literal]: 'const',
  [ValueErrorType.Union]: 'anyOf',
  [ValueErrorType.Intersect]: 'allOf',
  [ValueErrorType.IntersectUnevaluatedProperties]: 'unevaluatedProperties',
  [ValueErrorType.Not]: 'not',
  [ValueErrorType.Tuple]: 'items',
  [ValueErrorType.TupleLength]: 'items',
}

/** The JSON Schema keyword a TypeBox error type checks; `type` for one that checks a kind. */
export function keywordOf(type: ValueErrorType): string {
  return KEYWORDS[type] ?? 'type'
}
