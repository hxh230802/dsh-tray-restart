/**
 * 手动打一次菜单补丁（插件未加载时也能用）。
 *
 *   node scripts/apply.mjs [app.asar 路径]
 *
 * 插件正常加载时会自动做同样的事；这个脚本用于首次安装后想立即落盘、
 * 或排查插件为什么没跑起来。
 */
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const asarPath = process.argv[2]
  || path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')

if (!existsSync(asarPath)) {
  console.error(`app.asar not found: ${asarPath}`)
  process.exit(1)
}

const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME : path.join(os.homedir(), '.dsh')
process.env.DSH_HOME = home

const ctx = {
  logger: {
    info: (m) => console.log(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  },
}

const { apply } = await import('../lib/index.js')
apply(ctx, { asarPath, dryRun: false, verifySyntax: true })

const statusPath = path.join(home, 'dsh-tray-restart', 'status.json')
if (existsSync(statusPath)) {
  const status = JSON.parse(readFileSync(statusPath, 'utf8'))
  console.log('status:', JSON.stringify(status))
  if (status.state === 'patched') {
    console.log('restart DeepSeek Harness to see “重启 DeepSeek Harness”.')
  }
} else {
  console.error('no status file written')
  process.exit(1)
}
