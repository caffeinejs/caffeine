export async function forceGC(): Promise<void> {
  if (typeof global.gc === 'function') {
    global.gc()
    await new Promise(r => setTimeout(r, 50))
    global.gc()
  }
}
