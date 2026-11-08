import { fileURLToPath } from 'node:url'

import { buildStatic } from '@caffeinejs/static/build'

// Writes the manifest, and the compressed variants, that `staticFiles(...)` serves `public/` from.
const report = await buildStatic({ root: fileURLToPath(new URL('../public', import.meta.url)) })

console.log(`built ${report.files} static files with ${report.variants} compressed variants`)
