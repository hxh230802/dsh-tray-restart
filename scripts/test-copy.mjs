/**
 * 在 app.asar 的副本上验证补丁：长度、语法、写入、读回、还原。
 * 不会碰正在使用的 app.asar。
 *
 *   node scripts/test-copy.mjs [源 app.asar 路径]
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readArchiveEntry, sha256, verifyArchiveEntry, writeArchiveEntry } from '../lib/asar-entry.js'
import { isPatched, patchMainJs } from '../lib/main-patch.js'

const source = process.argv[2]
  || path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
if (!existsSync(source)) {
  console.error(`app.asar not found: ${source}`)
  process.exit(1)
}

const root = path.join(os.tmpdir(), `dsh-tray-restart-test-${process.pid}`)
mkdirSync(root, { recursive: true })
const copy = path.join(root, 'app.asar')
copyFileSync(source, copy)
console.log(`copied ${source} -> ${copy}`)

const parts = ['lib', 'main.js']
const entry = readArchiveEntry(copy, parts)
const original = entry.data
if (isPatched(original.toString('utf8'))) {
  console.error('FAIL: source app.asar already carries the marker')
  process.exit(1)
}

const { source: patched, removedComments } = patchMainJs(original.toString('utf8'))
const patchedBytes = Buffer.from(patched, 'utf8')
if (patchedBytes.length !== original.length) {
  console.error(`FAIL: length mismatch ${patchedBytes.length} != ${original.length}`)
  process.exit(1)
}

const patchedFile = path.join(root, 'main.patched.mjs')
writeFileSync(patchedFile, patchedBytes)
const check = spawnSync(process.execPath, ['--check', patchedFile], { encoding: 'utf8' })
if (check.status !== 0) {
  console.error('FAIL: syntax check')
  console.error(check.stderr)
  process.exit(1)
}

const patchedHash = sha256(patchedBytes)
const written = writeArchiveEntry(copy, entry, patchedBytes)
verifyArchiveEntry(copy, parts, patchedHash)
if (!written.headerUpdated) {
  console.error('FAIL: header integrity was not updated')
  process.exit(1)
}
console.log(`patched copy ok (removed ${removedComments} comments, sha256 ${patchedHash.slice(0, 12)}…)`)

const readBack = readArchiveEntry(copy, parts)
writeArchiveEntry(copy, readBack, original)
verifyArchiveEntry(copy, parts, sha256(original))
console.log('restore ok')
rmSync(root, { recursive: true, force: true })
console.log('PASS')
