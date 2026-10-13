/**
 * Regression proof for the dsh-better-sidebar alpha.1 back-port.
 *
 * The two crashes are API-shape crashes, so they are reproducible without the
 * GUI: take the ACTUAL code that now ships in the deployed bundles, hand it
 * objects shaped exactly like the deployed 0.1.2-alpha.1 services, and show
 * that (a) the old code throws the reported errors and (b) the new code does
 * not.
 *
 * Shapes are copied from the deployed runtime:
 *  - `ctx.connection` ← dsh-client-connection/lib/client.js `ctx.provide("connection", handle)`
 *    → { isLoopback, generation:{getSnapshot,subscribe}, rpc, registerGenerationSource, start }
 *  - `session`        ← dsh-session/lib/index.js `get events()` (cached, invalidated on append)
 */
import { readFileSync } from 'node:fs'

const LIB = 'D:/DeepSeekAgent/resources/packages/extensions/dsh-better-sidebar/lib'
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
}

// ---------------------------------------------------------------- fixture --
/** The exact alpha.1 client connection handle (no `state`, no `reconnect`). */
const alpha1Connection = {
  isLoopback: true,
  generation: { getSnapshot: () => undefined, subscribe: () => () => {} },
  rpc: { call: () => Promise.resolve() },
  registerGenerationSource: () => () => {},
  start: () => ({ stop: () => {} }),
}
const alpha1Ctx = { connection: alpha1Connection }

/** The exact alpha.1 Session log face: an `events` getter, no method. */
let sessionLog = [{ seq: 0, type: 'session/end-seed' }, { seq: 1, type: 'tool/call' }]
const alpha1Session = {
  get events() {
    return Object.freeze([...sessionLog])
  },
  header: { id: 'session-x' },
}
const touchSession = () => { sessionLog = [...sessionLog, { seq: sessionLog.length, type: 'tool/result' }] }

// ------------------------------------------------- 1. connection.state ---
const client = readFileSync(`${LIB}/client.js`, 'utf8')
const registry = readFileSync(`${LIB}/client-registry.js`, 'utf8')

for (const [label, source] of [['client.js', client], ['client-registry.js', registry]]) {
  check(`${label}: ships the feature-detected read`,
    source.includes('const connectionRecovery = ctx.connection?.state;'))
  check(`${label}: no bare state dereference left`,
    !/ctx\.connection\?\.state\.(getSnapshot|subscribe)\(/.test(source))
  check(`${label}: reconnect is now an optional call`,
    source.includes('ctx.connection?.reconnect?.();') && !source.includes('ctx.connection?.reconnect();'))
}

/** The expression the bundle actually evaluates (same operators, same order). */
const readStateOld = (ctx) => ctx.connection?.state.getSnapshot()
const readStateNew = (ctx) => {
  const connectionRecovery = ctx.connection?.state
  return connectionRecovery?.getSnapshot()
}

let oldError
try { readStateOld(alpha1Ctx) } catch (error) { oldError = error }
check('old expression reproduces the reported crash',
  oldError instanceof TypeError && oldError.message.includes("reading 'getSnapshot'"),
  oldError === undefined ? 'did not throw' : `${oldError.name}: ${oldError.message}`)
check('new expression degrades to undefined',
  readStateNew(alpha1Ctx) === undefined)

const alpha2Ctx = {
  connection: {
    ...alpha1Connection,
    state: { getSnapshot: () => 'disconnected', subscribe: () => () => {} },
  },
}
check('new expression still reads a real state on newer hosts',
  readStateNew(alpha2Ctx) === 'disconnected')

// --------------------------------------------------- 2. session log ------
const index = readFileSync(`${LIB}/index.js`, 'utf8')

check('host bundle ships the session-log shim', index.includes('function sessionLogEvents(session)'))
check('host bundle has no live snapshotEvents() call left',
  !/\.snapshotEvents\(\)/.test(index.replace(/function sessionLogEvents[\s\S]*?\n}/, '').replace(/^\s*\*.*$/gm, '')))

// Extract the shim verbatim from the shipped bundle and run it.
const shimMatch = index.match(/function sessionLogEvents\(session\) \{[\s\S]*?\n\}/)
check('shim extracted from the shipped bundle', shimMatch !== null)
const loadShim = new Function(`${shimMatch[0]}\nreturn sessionLogEvents;`)()
const sessionLogEvents = loadShim

let oldSessionError
try { alpha1Session.snapshotEvents() } catch (error) { oldSessionError = error }
check('old call reproduces the alpha.1 failure',
  oldSessionError instanceof TypeError,
  oldSessionError === undefined ? 'did not throw' : oldSessionError.message)

check('shim reads the alpha.1 `events` property',
  JSON.stringify(sessionLogEvents(alpha1Session)) === JSON.stringify(alpha1Session.events))

touchSession()
check('shim sees events appended after the first read',
  sessionLogEvents(alpha1Session).length === 3)

const alpha4Session = { snapshotEvents: () => Object.freeze([{ seq: 0 }]) }
check('shim prefers the newer method', sessionLogEvents(alpha4Session).length === 1)
check('shim returns undefined for an absent session', sessionLogEvents(undefined) === undefined)
check('shim returns undefined when neither face exists', sessionLogEvents({ header: {} }) === undefined)
check('shim survives a throwing method', sessionLogEvents({ snapshotEvents: () => { throw new Error('mid-teardown') } }) === undefined)

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length === 0 ? 0 : 1)
