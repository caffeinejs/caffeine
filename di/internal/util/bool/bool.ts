export function parseBool(value: string): boolean | undefined {
  switch (value.toLowerCase()) {
    case '1':
    case 't':
    case 'true':
    case 'on':
    case 'yes':
      return true
    case '0':
    case 'f':
    case 'false':
    case 'off':
    case 'no':
      return false
    default:
      return undefined
  }
}
