// Automated test: loading a historical session whose `tool/result` event has a
// missing or empty `callId` (artifact of the prior empty tool-name bug) must
// NOT be rejected as "corrupt". The `tool` source kind is still required, and a
// genuine mismatch between non-empty callIds is still rejected.
//
// Run: node scripts/test-session-tool-source.mjs
import { pathToFileURL } from 'node:url'

const { adoptSessionEvent } = await import(
  pathToFileURL('D:/DeepSeekAgent/resources/dsh-runtime/node_modules/@deepseek-ai/dsh-session/lib/index.js').href
)

let failed = false
function check(cond, label) {
  if (cond) {
    console.log(`PASS: ${label}`)
  } else {
    console.error(`FAIL: ${label}`)
    failed = true
  }
}

// 1) tool/result with EMPTY callId (the exact historical corrupt shape) loads.
const emptyCallId = {
  seq: 102,
  type: 'tool/result',
  data: {
    message: {
      id: 'msg-tool-102',
      role: 'user',
      source: { kind: 'tool', callId: '' },
      content: [{ type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'done' }] }],
    },
  },
}
try {
  adoptSessionEvent(emptyCallId)
  check(true, 'tool/result with empty callId is adopted (history loads)')
} catch (e) {
  check(false, `tool/result with empty callId threw: ${e.message}`)
}

// 2) tool/result with MISSING callId also loads.
const missingCallId = {
  seq: 103,
  type: 'tool/result',
  data: {
    message: {
      id: 'msg-tool-103',
      role: 'user',
      source: { kind: 'tool' },
      content: [{ type: 'tool-result', toolCallId: '', content: [{ type: 'text', text: 'done' }] }],
    },
  },
}
try {
  adoptSessionEvent(missingCallId)
  check(true, 'tool/result with missing callId is adopted (history loads)')
} catch (e) {
  check(false, `tool/result with missing callId threw: ${e.message}`)
}

// 3) Wrong source kind is STILL rejected (real corruption).
const wrongKind = {
  seq: 5,
  type: 'tool/result',
  data: {
    message: {
      id: 'm3',
      role: 'user',
      source: { kind: 'model' },
      content: [{ type: 'tool-result', toolCallId: '', content: [] }],
    },
  },
}
try {
  adoptSessionEvent(wrongKind)
  check(false, 'wrong source kind should have been rejected')
} catch (e) {
  check(String(e.message).includes('must have tool source'), `wrong source kind rejected: ${e.message}`)
}

// 4) Mismatched non-empty callId is STILL rejected (integrity preserved).
const mismatch = {
  seq: 6,
  type: 'tool/result',
  data: {
    message: {
      id: 'm4',
      role: 'user',
      source: { kind: 'tool', callId: 'abc' },
      content: [{ type: 'tool-result', toolCallId: 'xyz', content: [] }],
    },
  },
}
try {
  adoptSessionEvent(mismatch)
  check(false, 'mismatched non-empty callId should have been rejected')
} catch (e) {
  check(String(e.message).includes('mismatched'), `mismatched callId rejected: ${e.message}`)
}

if (failed) {
  console.error('\nOVERALL: FAIL')
  process.exit(1)
}
console.log('\nOVERALL: PASS')
