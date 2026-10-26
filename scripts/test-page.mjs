/**
 * 插件页自测：
 *   1. host 侧注册 /status /apply /restore 路由，并在 app.asar 副本上跑通
 *      打补丁 → 状态 → 还原 → 解除暂停 → 再打补丁；
 *   2. client 侧在假 slots 环境里注册 plugins.bundle.config 卡片。
 *
 *   node scripts/test-page.mjs
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { readArchiveEntry, writeArchiveEntry } from '../lib/asar-entry.js'

const pluginRoot = fileURLToPath(new URL('..', import.meta.url))
const root = path.join(os.tmpdir(), `dsh-tray-restart-page-${process.pid}`)
const home = path.join(root, 'home')
const asar = path.join(root, 'app.asar')
mkdirSync(home, { recursive: true })
process.env.DSH_HOME = home

const sourceAsar = path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
if (!existsSync(sourceAsar)) {
  console.error(`app.asar not found: ${sourceAsar}`)
  process.exit(1)
}
copyFileSync(sourceAsar, asar)

// 本机安装的 app.asar 可能已经打过补丁；用真实备份把副本还原成原始 main.js，才能测 apply。
const entry = readArchiveEntry(asar, ['lib', 'main.js'])
if (entry.data.toString('utf8').includes('dsh-tray-restart:menu')) {
  const realHome = path.join(process.env.USERPROFILE ?? os.homedir(), '.dsh')
  const backupMain = path.join(realHome, 'dsh-tray-restart', 'backup', 'main.original.js')
  if (!existsSync(backupMain)) {
    console.error(`source app.asar is patched and no original backup exists at ${backupMain}`)
    process.exit(1)
  }
  writeArchiveEntry(asar, entry, readFileSync(backupMain))
  console.log('copy restored to the original main.js for testing')
}

const routes = []
const webCtx = {
  effect: (factory) => {
    const disposer = factory()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
  },
}
const logs = []
const ctx = {
  logger: {
    info: (m) => logs.push(`info ${m}`),
    warn: (m) => logs.push(`warn ${m}`),
    error: (m) => logs.push(`error ${m}`),
  },
  effect: (factory) => {
    const disposer = factory()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  inject: (deps, callback) => {
    if (Array.isArray(deps) && deps.includes('webServer')) callback(webCtx)
  },
}

const { apply } = await import('../lib/index.js')
apply(ctx, { asarPath: asar, verifySyntax: true })

if (routes.length !== 1) {
  console.error(`FAIL: expected 1 route, got ${routes.length}`)
  console.error(logs.join('\n'))
  process.exit(1)
}

function call(method, sub) {
  let code = 0
  let body = ''
  const res = {
    writeHead: (nextCode) => {
      code = nextCode
    },
    end: (chunk) => {
      body += chunk ?? ''
    },
  }
  routes[0].handler(
    { method, url: `/plugins/dsh-tray-restart${sub}`, headers: { host: '127.0.0.1:19387', origin: 'http://127.0.0.1:19387' } },
    res,
  )
  return { code, json: JSON.parse(body) }
}

const status1 = call('GET', '/status')
console.log('status after apply:', status1.json.status.state, status1.json.status.appVersion)
if (status1.json.status.state !== 'patched') {
  console.error('FAIL: expected patched')
  process.exit(1)
}

const status2 = call('POST', '/apply')
if (status2.json.status.state !== 'already-patched') {
  console.error('FAIL: expected already-patched')
  process.exit(1)
}

const restored = call('POST', '/restore')
console.log('restore raw:', JSON.stringify(restored.json))
console.log('restore:', restored.json.status.state)
if (restored.json.status.state !== 'restored') {
  console.error('FAIL: expected restored')
  process.exit(1)
}

const status3 = call('GET', '/status')
if (status3.json.status.state !== 'restored-hold') {
  console.error(`FAIL: expected restored-hold, got ${status3.json.status.state}`)
  process.exit(1)
}

const reapply = call('POST', '/apply')
if (reapply.json.status.state !== 'patched') {
  console.error(`FAIL: expected patched after manual apply, got ${reapply.json.status.state}`)
  process.exit(1)
}

// ---- client half ----
const clientSource = readFileSync(path.join(pluginRoot, 'lib', 'client.js'), 'utf8')
let loaded
const ReactStub = {
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useCallback: (fn) => fn,
  createElement: (type, props, ...children) => ({ type, props, children }),
}
const requireStub = (id) => {
  if (id === 'react') return ReactStub
  throw new Error(`unexpected require: ${id}`)
}
const registrations = []
const slots = {
  inject: (key, callback) => {
    callback()
    return () => {}
  },
  register: (options, component) => {
    registrations.push({ options, component })
    return () => {}
  },
}
const clientCtx = {
  slots,
  effect: (factory) => {
    factory()
  },
  get: () => slots,
}
const sandbox = {
  window: { __ModuleLoader__: { load: ({ factory }) => { loaded = factory(requireStub) } } },
  console,
  setTimeout,
  fetch: () => Promise.reject(new Error('no fetch in test')),
}
vm.runInNewContext(clientSource, sandbox, { filename: 'client.js' })

if (!loaded || typeof loaded.apply !== 'function') {
  console.error('FAIL: client module did not export apply')
  process.exit(1)
}
await loaded.apply(clientCtx)
if (registrations.length !== 1 || registrations[0].options.key !== '@hxhxh/dsh-tray-restart') {
  console.error('FAIL: plugins.bundle.config card not registered')
  console.error(JSON.stringify(registrations.map((r) => r.options)))
  process.exit(1)
}
if (typeof registrations[0].component !== 'function') {
  console.error('FAIL: config card is not a component')
  process.exit(1)
}
const page = registrations[0].component({ view: 'page' })
if (page === null || typeof page !== 'object') {
  console.error('FAIL: config card did not render')
  process.exit(1)
}
const summary = registrations[0].component({ view: 'summary' })
if (summary === null || typeof summary !== 'object') {
  console.error('FAIL: summary did not render')
  process.exit(1)
}
console.log('client card registered:', registrations[0].options.name, registrations[0].options.key)

rmSync(root, { recursive: true, force: true })
console.log('PASS')
