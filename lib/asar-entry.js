/**
 * 最小 asar 读写：解析 header、定位一个文件、原长度改写它的字节。
 *
 * 只依赖 Node 内置模块，不引入 @electron/asar，避免插件安装时再装依赖。
 * header 的布局（Electron 的 asar 格式）：
 *   0..4     pickle 头
 *   4..8     header 载荷长度
 *   8..12    header 字符串长度
 *   12..16   header 字符串长度（再次）
 *   16..     header JSON
 *   data     = 16 + headerSize + entry.offset
 */

import { createHash } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readSync, writeSync } from 'node:fs'

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Electron 的 fs 会把任何带 `.asar` 的路径当成“归档内路径”，连 app.asar 本身
 * 都打不开（ENOENT, not found in …\app.asar）。同步操作期间临时关掉 asar 支持。
 */
function withoutAsar(operation) {
  const previous = process.noAsar
  process.noAsar = true
  try {
    return operation()
  } finally {
    process.noAsar = previous
  }
}

function readHeader(fd) {
  const head = Buffer.alloc(16)
  readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(12)
  if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize > 64 * 1024 * 1024) {
    throw new Error(`unexpected asar header size: ${headerSize}`)
  }
  const headerBuffer = Buffer.alloc(headerSize)
  readSync(fd, headerBuffer, 0, headerSize, 16)
  const header = JSON.parse(headerBuffer.toString('utf8'))
  return { headerSize, headerBuffer, header }
}

/**
 * 读取 asar 里的一个文件。
 * @param {string} asarPath
 * @param {string[]} parts 路径分段，例如 ['lib','main.js']
 */
export function readArchiveEntry(asarPath, parts) {
  return withoutAsar(() => {
    const fd = openSync(asarPath, 'r')
    try {
      const { headerSize, headerBuffer, header } = readHeader(fd)
      let node = header
      for (const part of parts) node = node?.files?.[part]
      if (node === undefined || node.files !== undefined) {
        throw new Error(`asar entry not found: ${parts.join('/')}`)
      }
      const dataStart = 16 + headerSize + Number(node.offset)
      const size = Number(node.size)
      const data = Buffer.alloc(size)
      readSync(fd, data, 0, size, dataStart)
      return { headerSize, headerBuffer, header, node, dataStart, data }
    } finally {
      closeSync(fd)
    }
  })
}

/**
 * 原地写入某个 entry 的新字节；如果长度不变，同时更新 header 里的 integrity 摘要。
 * 长度变化会直接拒绝，避免挪动后续文件的偏移。
 */
export function writeArchiveEntry(asarPath, entry, data) {
  const { headerSize, header, node, dataStart } = entry
  if (data.length !== Number(node.size)) {
    throw new Error(`refusing to resize asar entry (${data.length} != ${node.size})`)
  }

  const nextHash = sha256(data)
  let headerBuffer
  if (node.integrity !== undefined) {
    node.integrity.hash = nextHash
    if (Array.isArray(node.integrity.blocks) && node.integrity.blocks.length === 1) {
      node.integrity.blocks[0] = nextHash
    }
    const serialized = JSON.stringify(header)
    const candidate = Buffer.from(serialized, 'utf8')
    if (candidate.length === headerSize) headerBuffer = candidate
    // 长度对不上就不动 header：运行时通常不校验逐文件摘要，保持原 header 更安全。
  }

  return withoutAsar(() => {
    const fd = openSync(asarPath, 'r+')
    try {
      writeSync(fd, data, 0, data.length, dataStart)
      fsyncSync(fd)
      if (headerBuffer !== undefined) {
        writeSync(fd, headerBuffer, 0, headerBuffer.length, 16)
        fsyncSync(fd)
      }
    } finally {
      closeSync(fd)
    }
    return { hash: nextHash, headerUpdated: headerBuffer !== undefined }
  })
}

/**
 * 读回 entry 并校验哈希，确认写入真的落到磁盘。
 */
export function verifyArchiveEntry(asarPath, parts, expectedHash) {
  const entry = readArchiveEntry(asarPath, parts)
  const actual = sha256(entry.data)
  if (actual !== expectedHash) {
    throw new Error(`asar verify failed for ${parts.join('/')}: ${actual} != ${expectedHash}`)
  }
  return true
}
