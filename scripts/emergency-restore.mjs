/**
 * 紧急还原：即使 app.asar 的 header 已经被写坏、常规 restore.mjs 无法解析，
 * 也能按 manifest 记录的原始偏移直接把 main.js 和 header 写回去。
 *
 *   node scripts/emergency-restore.mjs
 *
 * 使用同一份 ~/.dsh/dsh-tray-restart/backup/manifest.json。
 */
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
const dir = path.join(home, 'dsh-tray-restart', 'backup')
const manifestPath = path.join(dir, 'manifest.json')
const originalPath = path.join(dir, 'main.original.js')
const headerPath = path.join(dir, 'header.original.bin')

if (!existsSync(manifestPath) || !existsSync(originalPath)) {
  console.error(`no backup found in ${dir}`)
  process.exit(1)
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
const original = readFileSync(originalPath)
const header = existsSync(headerPath) ? readFileSync(headerPath) : undefined

process.noAsar = true
const fd = openSync(manifest.asarPath, 'r+')
try {
  writeSync(fd, original, 0, original.length, manifest.dataStart)
  fsyncSync(fd)
  if (header !== undefined) {
    writeSync(fd, header, 0, header.length, 16)
    fsyncSync(fd)
  }
} finally {
  closeSync(fd)
}

console.log(`restored ${manifest.asarPath}`)
console.log(header === undefined ? 'main.js restored (no header backup present)' : 'main.js + original asar header restored')
console.log('restart DeepSeek Harness.')
