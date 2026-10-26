/**
 * 只读冒烟测试：用真实 app.asar 计算补丁并做语法校验，但不写入。
 *
 *   node scripts/dry-run.mjs
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const home = path.join(pluginRoot, '.smoke-home')
process.env.DSH_HOME = home

const asarPath = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
if (!existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`)
  process.exit(1)
}

const messages = []
const ctx = {
  logger: {
    info: (m) => messages.push(`info ${m}`),
    warn: (m) => messages.push(`warn ${m}`),
    error: (m) => messages.push(`error ${m}`),
  },
}

const { apply } = await import('../lib/index.js')
apply(ctx, { dryRun: true, asarPath })

const status = JSON.parse(readFileSync(path.join(home, 'dsh-tray-restart', 'status.json'), 'utf8'))
console.log('status:', JSON.stringify(status))
if (status.state !== 'dry-run' && status.state !== 'already-patched') {
  console.error('FAIL: unexpected status')
  console.error(messages.join('\n'))
  process.exit(1)
}
if (status.state === 'dry-run') {
  const patched = path.join(home, 'dsh-tray-restart', 'main.patched.mjs')
  if (!existsSync(patched)) {
    console.error('FAIL: patched file not written')
    process.exit(1)
  }
  const size = statSync(patched).size
  const { readArchiveEntry } = await import('../lib/asar-entry.js')
  const expected = readArchiveEntry(asarPath, ['lib', 'main.js']).data.length
  if (size !== expected) {
    console.error(`FAIL: unexpected patched size ${size} (expected ${expected} for this build)`)
    process.exit(1)
  }
  console.log(`patched file size ok: ${size}`)
}
console.log('PASS: dry-run')
