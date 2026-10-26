/**
 * 手动还原 dsh-tray-restart 写进 app.asar 的菜单补丁。
 *
 *   node scripts/restore.mjs
 *
 * 使用 ~/.dsh/dsh-tray-restart/backup/ 里的 manifest.json 和 main.original.js。
 * 只在“当前 main.js 仍是本插件写入的那一版”时才还原；应用更新过就拒绝，
 * 避免把旧文件覆盖到新版本上。
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readArchiveEntry, sha256, verifyArchiveEntry, writeArchiveEntry } from '../lib/asar-entry.js'

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
const backupDir = path.join(home, 'dsh-tray-restart', 'backup')
const manifestPath = path.join(backupDir, 'manifest.json')
const originalPath = path.join(backupDir, 'main.original.js')

if (!existsSync(manifestPath) || !existsSync(originalPath)) {
  console.error(`no backup found in ${backupDir}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const original = readFileSync(originalPath)
const parts = String(manifest.entry ?? 'lib/main.js').split('/')
const entry = readArchiveEntry(manifest.asarPath, parts)
const currentHash = sha256(entry.data)

if (currentHash !== manifest.patchedSha256) {
  console.error('refusing to restore: current main.js is not the patched copy from this plugin.')
  console.error(`  expected patched sha256: ${manifest.patchedSha256}`)
  console.error(`  current sha256:          ${currentHash}`)
  console.error('The desktop app was probably updated; leave it alone or re-install the plugin.')
  process.exit(1)
}

writeArchiveEntry(manifest.asarPath, entry, original)
verifyArchiveEntry(manifest.asarPath, parts, manifest.originalSha256)
console.log('restored original lib/main.js into')
console.log(`  ${manifest.asarPath}`)
console.log('restart DeepSeek Harness to see the stock menu.')
