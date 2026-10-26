/**
 * 对桌面端 lib/main.js 的菜单补丁。
 *
 * 目标：
 *   1. 系统托盘右键菜单：在「打开」和「退出」之间加入「重启 DeepSeek Harness」；
 *   2. 应用菜单（macOS 菜单栏 / Windows 标题栏「应用」弹出菜单）：把原本只在
 *      development 下出现的「重启应用与 Host」移到所有构建都有的位置，并改名为
 *      「重启 DeepSeek Harness」。
 *
 * 关键约束：main.js 的字节长度必须保持不变。asar 里每个文件都带固化的 offset，
 * 改长度就会让后面的文件错位；所以这里先做文本替换，再删掉同区域里等长的
 * 注释，最后用空格补齐到原始字节数。插入的菜单文案固定为「重启 DeepSeek Harness」，
 * 不随界面语言变化。
 */

export const MARKER = 'dsh-tray-restart:menu:v2'
export const PATCH_VERSION = 2

const TRAY_OLD = `\t\t\t{ type: "separator" },
\t\t\t{
\t\t\t\tlabel: messages.quitApplication,`

const TRAY_NEW = `\t\t\t{ type: "separator" },
\t\t\t/* ${MARKER} */
\t\t\t{
\t\t\t\tlabel: "重启 DeepSeek Harness",
\t\t\t\tclick: () => {
\t\t\t\t\tapp.relaunch();
\t\t\t\t\tquitWithoutConfirmation();
\t\t\t\t}
\t\t\t},
\t\t\t{
\t\t\t\tlabel: messages.quitApplication,`

const APP_OLD = `\t\t...development ? [
\t\t\t{ type: "separator" },
\t\t\t{
\t\t\t\tlabel: currentDesktopLocale().messages.reloadPageMenu,
\t\t\t\trole: "reload"
\t\t\t},
\t\t\t{
\t\t\t\tlabel: currentDesktopLocale().messages.restartAppHostMenu,
\t\t\t\tclick: () => {
\t\t\t\t\tif (quitting) return;
\t\t\t\t\tapp.relaunch();
\t\t\t\t\tquitWithoutConfirmation();
\t\t\t\t}
\t\t\t}
\t\t] : [],`

const APP_NEW = `\t\t{
\t\t\tlabel: "重启 DeepSeek Harness",
\t\t\tclick: () => {
\t\t\t\tif (quitting) return;
\t\t\t\tapp.relaunch();
\t\t\t\tquitWithoutConfirmation();
\t\t\t}
\t\t},
\t\t...development ? [
\t\t\t{ type: "separator" },
\t\t\t{
\t\t\t\tlabel: currentDesktopLocale().messages.reloadPageMenu,
\t\t\t\trole: "reload"
\t\t\t}
\t\t] : [],`

/** 删掉这些不会影响行为的注释，用来抵消插入的字节。 */
const REMOVABLE_COMMENTS = [
  '\t/** @param options - Icon path, locale reader, and the open and quit actions. */\n',
  '\t/** Rebuild the tooltip and context menu in the current locale. */\n',
  '\t/** Remove the icon; called once the quit is confirmed so no dead icon outlives the process. */\n',
  '/** Windows system tray: the always-present way back to a hidden window and the explicit quit entry. */\n',
  '/** Tray icon present for the whole run, not only while the window is hidden. */\n',
]

/**
 * 判断 main.js 是否已经打过补丁。
 * @param {string} source
 */
export function isPatched(source) {
  return source.includes(MARKER)
}

/**
 * 生成补丁后的 main.js 文本，长度（UTF-8 字节）与输入完全一致。
 * @param {string} source 原始 main.js 文本
 * @returns {{ source: string, changed: boolean, removedComments: number, byteLength: number }}
 */
export function patchMainJs(source) {
  const targetBytes = Buffer.byteLength(source, 'utf8')
  if (isPatched(source)) {
    return { source, changed: false, removedComments: 0, byteLength: targetBytes }
  }
  if (!source.includes(TRAY_OLD)) {
    throw new Error('tray menu anchor not found; this DSH desktop build is unsupported')
  }
  if (!source.includes(APP_OLD)) {
    throw new Error('application menu anchor not found; this DSH desktop build is unsupported')
  }

  let patched = source.replace(TRAY_OLD, TRAY_NEW).replace(APP_OLD, APP_NEW)
  let removedComments = 0
  for (const comment of REMOVABLE_COMMENTS) {
    if (Buffer.byteLength(patched, 'utf8') <= targetBytes) break
    if (!patched.includes(comment)) continue
    patched = patched.replace(comment, '')
    removedComments += 1
  }

  const currentBytes = Buffer.byteLength(patched, 'utf8')
  if (currentBytes > targetBytes) {
    throw new Error(`patch is ${currentBytes - targetBytes} bytes too long; refusing to resize asar entry`)
  }
  if (currentBytes < targetBytes) {
    patched += ' '.repeat(targetBytes - currentBytes)
  }
  if (Buffer.byteLength(patched, 'utf8') !== targetBytes) {
    throw new Error('patched length does not match the original byte length')
  }

  return { source: patched, changed: true, removedComments, byteLength: targetBytes }
}
