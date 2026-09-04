if (typeof Symbol.metadata === 'undefined') {
  ;(Symbol as any).metadata = Symbol('Symbol.metadata')
}

if (typeof Symbol.dispose === 'undefined') {
  ;(Symbol as { dispose: symbol }).dispose = Symbol.for('Symbol.dispose')
}

if (typeof Symbol.asyncDispose === 'undefined') {
  ;(Symbol as { asyncDispose: symbol }).asyncDispose = Symbol.for('Symbol.asyncDispose')
}
