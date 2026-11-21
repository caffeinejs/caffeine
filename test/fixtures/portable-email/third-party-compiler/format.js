export function format(value, kind) {
  const text = String(value)
  if (kind === 'text') {
    return text
  }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
