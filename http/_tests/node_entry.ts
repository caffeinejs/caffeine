// What the Node project hands the suites that run on both servers in place of the Fastify entry.
export { createWebApplication, newRouter } from '../platform/node/node.js'
export { authentication } from '../core/security/security.js'
export { csrf } from '../core/csrf/csrf.js'
export { constraints } from './constraints_entry.js'
