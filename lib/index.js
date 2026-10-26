/**
 * dsh-tray-restart — 把「重启 DeepSeek Harness」加进桌面端**现有**菜单，并给插件页
 * 提供 `plugins.bundle.config` 配置卡片。
 *
 * 托盘菜单和应用菜单都定义在 Electron 主进程的 lib/main.js 里，插件（Host 子进程）
 * 没有运行时扩展点，所以本插件在每次 Host 启动时检查 resources/app.asar 里的
 * lib/main.js：
 *
 *   - 没打过补丁 → 生成等长补丁、语法校验、备份原文件、原地写入；
 *   - 已打过 → 什么都不做；
 *   - 应用更新把 app.asar 换掉 → 下次启动自动重新打。
 *
 * 补丁内容：
 *   - 托盘右键菜单：打开 / 重启 DeepSeek Harness / 退出；
 *   - 应用菜单（Windows 标题栏「应用」、macOS 菜单栏）：生产构建也出现
 *     「重启 DeepSeek Harness」（原本只在 development 构建里出现）。
 *
 * 插件页提供：
 *   - GET  /plugins/dsh-tray-restart/status   补丁/备份/配置状态
 *   - POST /plugins/dsh-tray-restart/apply    立即打补丁（会解除“已还原”暂停）
 *   - POST /plugins/dsh-tray-restart/restore  还原原始菜单（并暂停自动补丁）
 *
 * 因为主进程已经加载了旧的 main.js，补丁需要**重启一次 DSH** 才生效。
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isPatched, patchMainJs, MARKER, PATCH_VERSION } from './main-patch.js'
import { readArchiveEntry, sha256, verifyArchiveEntry, writeArchiveEntry } from './asar-entry.js'

export const name = 'dsh-tray-restart'

const DEFAULTS = {
  enabled: true,
  /** 只生成补丁和做语法校验，不写 app.asar。 */
  dryRun: false,
  /** 写入前用 Node 做一次 --check；除非排查问题，不建议关闭。 */
  verifySyntax: true,
  /** 仅调试/非标准安装：显式指定 app.asar 路径（默认从 process.execPath 推导）。 */
  asarPath: '',
}

const ENTRY = ['lib', 'main.js']
const ROUTE = '/plugins/dsh-tray-restart'

let activeConfig = { ...DEFAULTS }
let patchBusy = false

function dshHome() {
  const value = process.env.DSH_HOME
  if (typeof value === 'string' && value.trim() !== '') return value
  return path.join(os.homedir(), '.dsh')
}

function workDir() {
  return path.join(dshHome(), 'dsh-tray-restart')
}

function backupDir() {
  return path.join(workDir(), 'backup')
}

function holdFile() {
  return path.join(workDir(), 'hold-restore.flag')
}

function logFile() {
  return path.join(dshHome(), 'logs', 'dsh-tray-restart.log')
}

function appendLog(level, message) {
  try {
    const file = logFile()
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${new Date().toISOString()} [${level}] ${message}\n`, 'utf8')
  } catch {
    // 日志失败不影响补丁
  }
}

function log(ctx, level, message) {
  const text = `dsh-tray-restart: ${message}`
  try {
    const logger = typeof ctx?.logger === 'function' ? ctx.logger('dsh-tray-restart') : ctx?.logger
    if (logger && typeof logger[level] === 'function') logger[level](text)
    else if (level === 'error') console.error(text)
    else if (level === 'warn') console.warn(text)
    else console.log(text)
  } catch {
    // ignore
  }
  appendLog(level, message)
}

function writeStatus(payload) {
  try {
    const dir = workDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, 'status.json'),
      `${JSON.stringify({ ...payload, patchVersion: PATCH_VERSION, time: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    )
  } catch {
    // 诊断文件写不了也不影响主流程
  }
}

function publicConfig(cfg) {
  return {
    enabled: cfg.enabled !== false,
    dryRun: cfg.dryRun === true,
    verifySyntax: cfg.verifySyntax !== false,
    asarPath: cfg.asarPath || '',
  }
}

/** 找打包桌面端的 app.asar；`dsh web` / 开发模式返回 undefined。 */
function resolveAsarPath(configured) {
  if (typeof configured === 'string' && configured.trim() !== '') {
    const explicit = path.resolve(configured.trim())
    return existsSync(explicit) ? explicit : undefined
  }
  if (typeof process.execPath !== 'string') return undefined
  const candidate = path.join(path.dirname(process.execPath), 'resources', 'app.asar')
  return existsSync(candidate) ? candidate : undefined
}

function archivedAppVersion(asarPath) {
  try {
    const entry = readArchiveEntry(asarPath, ['package.json'])
    return JSON.parse(entry.data.toString('utf8')).version ?? null
  } catch {
    return null
  }
}

function readBackupManifest() {
  try {
    return JSON.parse(readFileSync(path.join(backupDir(), 'manifest.json'), 'utf8'))
  } catch {
    return null
  }
}

/**
 * 只读地汇总补丁状态，供插件页展示。
 * @param {object} cfg 已合并默认值的配置
 */
function statusOf(cfg) {
  const base = {
    patchVersion: PATCH_VERSION,
    marker: MARKER,
    asarPath: null,
    appVersion: null,
    backupDir: backupDir(),
    backupAvailable: false,
    logPath: logFile(),
    hold: existsSync(holdFile()),
    config: publicConfig(cfg),
    patched: false,
    restartRequired: false,
  }
  const asarPath = resolveAsarPath(cfg.asarPath)
  if (asarPath === undefined) {
    return { ...base, state: 'skipped', reason: 'not-desktop' }
  }
  try {
    const entry = readArchiveEntry(asarPath, ENTRY)
    const patched = isPatched(entry.data.toString('utf8'))
    const manifest = readBackupManifest()
    let state = 'unpatched'
    if (patched) state = 'patched'
    else if (base.hold) state = 'restored-hold'
    return {
      ...base,
      state,
      patched,
      asarPath,
      appVersion: manifest?.appVersion ?? archivedAppVersion(asarPath),
      backupAvailable: manifest !== null,
      originalSha256: manifest?.originalSha256 ?? null,
      patchedSha256: manifest?.patchedSha256 ?? null,
      currentSha256: sha256(entry.data),
      restartRequired: patched,
    }
  } catch (error) {
    return { ...base, state: 'failed', reason: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * 用真实的 Node 解析一遍补丁后的 ESM，避免把语法错误写进 app.asar。
 * 优先用应用自带的 node.exe，退回 Electron 的 Node 模式。
 */
function checkSyntax(ctx, source, file) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, source, 'utf8')

  const candidates = []
  const bundled = path.join(
    path.dirname(process.execPath),
    'resources',
    'runtime',
    'primary-runtime',
    'dependencies',
    'node',
    'bin',
    'node.exe',
  )
  if (existsSync(bundled)) candidates.push({ command: bundled, args: ['--check', file], env: process.env })
  candidates.push({
    command: process.execPath,
    args: ['--check', file],
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })

  let lastError
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate.command, candidate.args, {
        env: candidate.env,
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
      })
      if (result.error !== undefined) {
        lastError = result.error
        continue
      }
      if (result.status === 0) return { ok: true, command: candidate.command }
      const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim().slice(0, 4000)
      return { ok: false, command: candidate.command, detail: detail || `node --check exited ${String(result.status)}` }
    } catch (error) {
      lastError = error
    }
  }
  log(ctx, 'warn', `syntax check unavailable: ${lastError instanceof Error ? lastError.message : String(lastError)}`)
  return { ok: false, unavailable: true }
}

function backupOriginal(asarPath, entry, originalBytes, patchedHash) {
  const dir = backupDir()
  mkdirSync(dir, { recursive: true })
  const originalPath = path.join(dir, 'main.original.js')
  writeFileSync(originalPath, originalBytes)
  const headerPath = path.join(dir, 'header.original.bin')
  writeFileSync(headerPath, entry.headerBuffer)
  const manifest = {
    patchVersion: PATCH_VERSION,
    marker: MARKER,
    asarPath,
    entry: ENTRY.join('/'),
    headerSize: entry.headerSize,
    dataStart: entry.dataStart,
    size: originalBytes.length,
    originalSha256: sha256(originalBytes),
    patchedSha256: patchedHash,
    appVersion: archivedAppVersion(asarPath),
    createdAt: new Date().toISOString(),
  }
  const manifestPath = path.join(dir, 'manifest.json')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return { originalPath, headerPath, manifestPath, manifest }
}

/**
 * 打补丁。任何失败都只记录，不向 Loader 抛错——插件加载失败会连累整个 profile。
 * @param {object} ctx Cordis 上下文
 * @param {object} cfg 已合并默认值的配置
 * @param {{ manual?: boolean }} options manual=true 时忽略“已还原暂停”并解除暂停
 */
export function runPatch(ctx, cfg, options = {}) {
  if (patchBusy) throw new Error('patch already in progress')
  patchBusy = true
  try {
    if (cfg.enabled === false) {
      log(ctx, 'info', 'disabled by config')
      return { state: 'disabled', config: publicConfig(cfg) }
    }

    const asarPath = resolveAsarPath(cfg.asarPath)
    if (asarPath === undefined) {
      log(ctx, 'info', `not a packaged Windows desktop (execPath=${process.execPath}); nothing to patch`)
      const status = { state: 'skipped', reason: 'not-desktop', asarPath: null, config: publicConfig(cfg) }
      writeStatus(status)
      return status
    }

    const entry = readArchiveEntry(asarPath, ENTRY)
    const originalBytes = entry.data
    const original = originalBytes.toString('utf8')

    if (isPatched(original)) {
      log(ctx, 'info', `menu patch already present: ${asarPath}`)
      const status = {
        state: 'already-patched',
        patched: true,
        asarPath,
        appVersion: archivedAppVersion(asarPath),
        backupDir: backupDir(),
        config: publicConfig(cfg),
        restartRequired: true,
      }
      writeStatus(status)
      return status
    }

    if (!options.manual && existsSync(holdFile())) {
      log(ctx, 'info', 'restore hold is active; automatic patch skipped')
      const status = { state: 'restored-hold', patched: false, asarPath, appVersion: archivedAppVersion(asarPath), config: publicConfig(cfg) }
      writeStatus(status)
      return status
    }

    const { source: patched, removedComments } = patchMainJs(original)
    const patchedBytes = Buffer.from(patched, 'utf8')
    if (patchedBytes.length !== originalBytes.length) {
      throw new Error(`internal length mismatch: ${patchedBytes.length} != ${originalBytes.length}`)
    }
    const patchedHash = sha256(patchedBytes)

    const patchedFile = path.join(workDir(), 'main.patched.mjs')
    let syntax = { ok: true, skipped: true }
    if (cfg.verifySyntax !== false) {
      syntax = checkSyntax(ctx, patched, patchedFile)
      if (!syntax.ok) {
        const reason = syntax.unavailable ? 'syntax check unavailable' : 'patched main.js failed syntax check'
        log(ctx, 'error', `${reason}; refusing to touch app.asar`)
        if (syntax.detail) appendLog('error', syntax.detail)
        const status = { state: 'failed', asarPath, reason, detail: syntax.detail ?? null, config: publicConfig(cfg) }
        writeStatus(status)
        return status
      }
    }

    if (cfg.dryRun === true) {
      log(ctx, 'info', `dry-run: patch is valid (${patchedBytes.length} bytes, removed ${removedComments} comments); app.asar untouched`)
      const status = {
        state: 'dry-run',
        asarPath,
        patchedFile,
        syntax: syntax.command ?? 'skipped',
        removedComments,
        config: publicConfig(cfg),
      }
      writeStatus(status)
      return status
    }

    const backup = backupOriginal(asarPath, entry, originalBytes, patchedHash)
    const written = writeArchiveEntry(asarPath, entry, patchedBytes)
    verifyArchiveEntry(asarPath, ENTRY, patchedHash)
    try {
      rmSync(holdFile(), { force: true })
    } catch {
      // ignore
    }

    log(
      ctx,
      'info',
      `menu patch written to ${asarPath} (header integrity ${written.headerUpdated ? 'updated' : 'left unchanged'}); restart DSH to see it`,
    )
    log(ctx, 'info', `original main.js backed up at ${backup.originalPath}`)
    const status = {
      state: 'patched',
      patched: true,
      restartRequired: true,
      asarPath,
      appVersion: backup.manifest.appVersion,
      patchedSha256: patchedHash,
      originalSha256: backup.manifest.originalSha256,
      backupDir: path.dirname(backup.originalPath),
      backupAvailable: true,
      patchedFile,
      removedComments,
      config: publicConfig(cfg),
    }
    writeStatus(status)
    return status
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(ctx, 'error', `menu patch failed: ${message}`)
    const status = { state: 'failed', asarPath: resolveAsarPath(cfg.asarPath) ?? null, reason: message, config: publicConfig(cfg) }
    writeStatus(status)
    return status
  } finally {
    patchBusy = false
  }
}

/**
 * 还原原始 main.js，并写入“暂停自动补丁”标记。
 * @param {object} ctx Cordis 上下文
 * @param {object} cfg 已合并默认值的配置
 */
export function restoreMenu(ctx, cfg) {
  const asarPath = resolveAsarPath(cfg.asarPath)
  if (asarPath === undefined) throw new Error('not a packaged desktop app')
  const manifest = readBackupManifest()
  if (manifest === null) throw new Error('没有找到备份，无法还原')

  const entry = readArchiveEntry(asarPath, ENTRY)
  const current = sha256(entry.data)
  if (current === manifest.originalSha256) {
    const status = { state: 'already-original', patched: false, asarPath, appVersion: archivedAppVersion(asarPath), config: publicConfig(cfg) }
    writeStatus(status)
    return status
  }
  if (current !== manifest.patchedSha256) {
    throw new Error('当前 main.js 不是本插件写入的版本，拒绝还原（应用可能已更新）')
  }

  const original = readFileSync(path.join(backupDir(), 'main.original.js'))
  writeArchiveEntry(asarPath, entry, original)
  verifyArchiveEntry(asarPath, ENTRY, manifest.originalSha256)
  mkdirSync(workDir(), { recursive: true })
  writeFileSync(holdFile(), `${new Date().toISOString()}\n`, 'utf8')

  log(ctx, 'info', `original main.js restored to ${asarPath}; automatic patch paused`)
  const status = {
    state: 'restored',
    patched: false,
    restartRequired: true,
    asarPath,
    appVersion: archivedAppVersion(asarPath),
    backupDir: backupDir(),
    hold: true,
    config: publicConfig(cfg),
  }
  writeStatus(status)
  return status
}

function trusted(req) {
  const origin = req.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return new URL(origin).host === req.headers.host
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 注册插件页使用的 HTTP 接口。webServer 晚于本插件就绪时，ctx.inject 会等它。
 */
function installWebRoutes(ctx, cfg) {
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'prefix',
            path: ROUTE,
            handler: (req, res) => {
              if (!trusted(req)) {
                sendJson(res, 403, { ok: false, error: 'forbidden origin' })
                return
              }
              let sub = '/'
              try {
                sub = new URL(req.url ?? '/', 'http://dsh.internal').pathname.slice(ROUTE.length)
              } catch {
                sub = '/'
              }
              try {
                if (req.method === 'GET' && sub === '/status') {
                  sendJson(res, 200, { ok: true, status: statusOf(activeConfig), patchVersion: PATCH_VERSION })
                  return
                }
                if (req.method === 'POST' && sub === '/apply') {
                  const status = runPatch(ctx, activeConfig, { manual: true })
                  sendJson(res, 200, { ok: status.state !== 'failed', status })
                  return
                }
                if (req.method === 'POST' && sub === '/restore') {
                  const status = restoreMenu(ctx, activeConfig)
                  sendJson(res, 200, { ok: true, status })
                  return
                }
                sendJson(res, 404, { ok: false, error: 'not found' })
              } catch (error) {
                sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) })
              }
            },
          }),
        'dsh-tray-restart: plugin page routes',
      )
    })
  } catch (error) {
    log(ctx, 'warn', `plugin page routes unavailable: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config !== null && typeof config === 'object' ? config : {}) }
  activeConfig = cfg
  if (cfg.enabled === false) {
    log(ctx, 'info', 'disabled by config')
    return
  }

  runPatch(ctx, cfg)
  installWebRoutes(ctx, cfg)
}

export { DEFAULTS as defaultConfig }
