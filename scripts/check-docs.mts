import { createRequire } from 'node:module'
import { run } from 'vue-tsc'

// Vue's checker needs the JavaScript compiler; runtime packages retain TS 7.
const require = createRequire(import.meta.url)
run(require.resolve('typescript-vue/lib/tsc.js'))
