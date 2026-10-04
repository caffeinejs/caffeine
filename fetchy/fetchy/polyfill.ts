// The registered symbol, as di installs it and as the SWC and Babel decorator helpers fall back to, so every class
// stores and reads its metadata under one key whichever of them loads first.
if (typeof Symbol.metadata === 'undefined') {
  ;(Symbol as any).metadata = Symbol.for('Symbol.metadata')
}
