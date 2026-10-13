/**
 * Back-port dsh-better-sidebar 0.18.1 to the deployed 0.1.2-alpha.1 harness.
 *
 * Two API generations are involved and the plugin only knows the newer one:
 *
 * 1. `Session.snapshotEvents()` — introduced in DSH 0.1.2-alpha.4 as the
 *    rename of the `Session.events` property. alpha.1 has only the property,
 *    so every host-side call site throws
 *    `session.snapshotEvents is not a function`.
 * 2. `ctx.connection.state` / `ctx.connection.reconnect()` — introduced in
 *    DSH 0.1.2-alpha.2. alpha.1 provides a `connection` service WITHOUT that
 *    face, so `ctx.connection?.state.getSnapshot()` dereferences `undefined`
 *    → `Cannot read properties of undefined (reading 'getSnapshot')` and the
 *    侧边对话(beta) tab crashes on render.
 *
 * The script patches the BUILT bundles under
 * `D:/DeepSeekAgent/resources/packages/extensions/dsh-better-sidebar/lib`
 * because the running GUI loads those, not the TypeScript source (which is
 * patched too, see ../../packages/extensions/DSH-better-sidebar-0.18.1/src).
 *
 * Every replacement asserts an exact match count so a reshuffled bundle fails
 * loudly instead of silently applying half a patch. Backs up each file to
 * `<name>.bak-alpha1-<ts>` before writing. Pass --dry to only report.
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const LIB = 'D:/DeepSeekAgent/resources/packages/extensions/dsh-better-sidebar/lib'
const DRY = process.argv.includes('--dry')
const STAMP = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)

/** The alpha.1-compatible session-log reader, plain ESM/CJS-safe JS. */
const HELPER = `/**
 * 兼容垫片：0.1.2-alpha.4 起 \`Session.snapshotEvents()\` 方法取代了 \`Session.events\`
 * 属性；部署的 harness（0.1.2-alpha.1）只提供属性。两者都是「追加即失效」的不可变
 * 快照，语义等价，故统一从这里读；session 缺失或日志不可读时返回 undefined，
 * 由调用方自行 \`?? []\`。
 */
function sessionLogEvents(session) {
	if (session === void 0 || session === null) return void 0;
	if (typeof session.snapshotEvents === "function") {
		try { return session.snapshotEvents(); } catch { return void 0; }
	}
	return Array.isArray(session.events) ? session.events : void 0;
}
`

/** [file, anchor(insert after, once), target, replacement, expectedCount] */
const HOST_EDITS = [
  [
    'ctx.sessions.get(sessionId)?.snapshotEvents() ?? []',
    'sessionLogEvents(ctx.sessions.get(sessionId)) ?? []',
  ],
  [
    'ctx.sessions.get(entry.id)?.snapshotEvents() ?? []',
    'sessionLogEvents(ctx.sessions.get(entry.id)) ?? []',
  ],
  [
    'return agent.session.snapshotEvents();',
    'return sessionLogEvents(agent.session) ?? [];',
  ],
  [
    'buildSidechatInheritance(parentSession.snapshotEvents())',
    'buildSidechatInheritance(sessionLogEvents(parentSession) ?? [])',
  ],
  [
    'resolvePresetId(parentSession.header, parentSession.snapshotEvents())',
    'resolvePresetId(parentSession.header, sessionLogEvents(parentSession) ?? [])',
  ],
  [
    'boundaryDelivered(agent.session.snapshotEvents())',
    'boundaryDelivered(sessionLogEvents(agent.session) ?? [])',
  ],
  [
    'ctx.sessions.get(sessionId)?.snapshotEvents();',
    'sessionLogEvents(ctx.sessions.get(sessionId));',
  ],
]

const CLIENT_BEFORE =
  'const connectionState = (0, react.useSyncExternalStore)((0, react.useMemo)(() => (callback) => ctx.connection?.state.subscribe(callback) ?? (() => {}), [ctx]), (0, react.useCallback)(() => ctx.connection?.state.getSnapshot(), [ctx]));'
const CLIENT_AFTER =
  'const connectionRecovery = ctx.connection?.state;\n'
  + '\t\t\tconst connectionState = (0, react.useSyncExternalStore)((0, react.useMemo)(() => (callback) => connectionRecovery?.subscribe(callback) ?? (() => {}), [connectionRecovery]), (0, react.useCallback)(() => connectionRecovery?.getSnapshot(), [connectionRecovery]));'
const RECONNECT_BEFORE = 'ctx.connection?.reconnect();'
const RECONNECT_AFTER = 'ctx.connection?.reconnect?.();'

/** Apply a list of [before, after] pairs with exact-count assertions. */
function applyEdits(label, source, edits) {
  let out = source
  const report = []
  for (const [before, after] of edits) {
    const hits = out.split(before).length - 1
    if (hits !== 1) {
      throw new Error(`${label}: expected exactly 1 match, got ${hits} for:\n  ${before}`)
    }
    out = out.replace(before, after)
    report.push(`    ok  ${before.slice(0, 72)}${before.length > 72 ? '…' : ''}`)
  }
  return { out, report }
}

const failures = []

// ---- host bundle: insert the helper, then rewrite every call site ----------
{
  const file = path.join(LIB, 'index.js')
  const source = readFileSync(file, 'utf8')
  try {
    const anchor = 'const SessionLogOffset = (n) => n;\n'
    if (source.split(anchor).length - 1 !== 1) throw new Error('index.js: SessionLogOffset anchor not unique')
    const withHelper = source.replace(anchor, anchor + HELPER)
    const { out, report } = applyEdits('index.js', withHelper, HOST_EDITS)
    console.log(`[index.js] 7 host call sites`)
    for (const line of report) console.log(line)
    // After the patch the only `.snapshotEvents()` mentions left are the
    // helper's own doc + body and the upstream explanatory comment: 3.
    const leftovers = out.match(/\.snapshotEvents\(\)/g) ?? []
    if (leftovers.length !== 3) {
      throw new Error(`index.js: ${leftovers.length} snapshotEvents() mentions remain (expected 3: helper doc + helper body + upstream comment)`)
    }
    for (const banned of [
      '?.snapshotEvents()',
      'agent.session.snapshotEvents()',
      'parentSession.snapshotEvents()',
      'sessionId)?.snapshotEvents();',
    ]) {
      if (out.includes(banned)) throw new Error(`index.js: live call site survived: ${banned}`)
    }
    if (!DRY) {
      copyFileSync(file, `${file}.bak-alpha1-${STAMP}`)
      writeFileSync(file, out)
      console.log(`  wrote ${out.length} bytes (backup .bak-alpha1-${STAMP})`)
    } else {
      console.log('  [dry] not written')
    }
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
}

// ---- client bundles: feature-detect ctx.connection.state -------------------
for (const name of ['client.js', 'client-registry.js']) {
  const file = path.join(LIB, name)
  const source = readFileSync(file, 'utf8')
  try {
    const { out, report } = applyEdits(name, source, [
      [CLIENT_BEFORE, CLIENT_AFTER],
      [RECONNECT_BEFORE, RECONNECT_AFTER],
    ])
    console.log(`[${name}] 2 client edits`)
    for (const line of report) console.log(line)
    if (out.includes('ctx.connection?.state.getSnapshot()')) {
      throw new Error(`${name}: the crashing expression survived`)
    }
    if (!DRY) {
      copyFileSync(file, `${file}.bak-alpha1-${STAMP}`)
      writeFileSync(file, out)
      console.log(`  wrote ${out.length} bytes (backup .bak-alpha1-${STAMP})`)
    } else {
      console.log('  [dry] not written')
    }
  } catch (error) {
    failures.push(String(error.message ?? error))
  }
}

if (failures.length > 0) {
  console.error('\nFAILED:')
  for (const f of failures) console.error(` - ${f}`)
  process.exit(1)
}
console.log(`\nOK — all ${DRY ? 'edits validated (dry run)' : 'edits applied'}.`)
