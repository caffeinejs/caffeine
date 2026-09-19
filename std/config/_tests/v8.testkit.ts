import { setFlagsFromString } from 'node:v8'

// V8's own answer to whether an object is in fast mode, where a read is a field load rather than a hash lookup. The
// flag only lets the function below parse.
setFlagsFromString('--allow-natives-syntax')

// oxlint-disable-next-line typescript/no-implied-eval -- natives syntax parses only from source compiled after the flag
export const hasFastProperties = new Function('value', 'return %HasFastProperties(value)') as (value: object) => boolean
