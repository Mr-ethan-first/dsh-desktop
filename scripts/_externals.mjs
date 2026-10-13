// List bare (non-relative, non-node:) module specifiers a built file depends on.
import { readFileSync } from 'node:fs'

const file = process.argv[2]
const src = readFileSync(file, 'utf8')
const set = new Set()
const re = /(?:from|import|require\()\s*['"]([^'"]+)['"]/g
for (const m of src.matchAll(re)) set.add(m[1])
const bare = [...set].filter((s) => !s.startsWith('.') && !s.startsWith('node:'))
console.log(bare.sort().join('\n') || '(none — fully bundled)')
