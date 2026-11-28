// 工作区文件系统：只读浏览 + 上传落盘。全部路径都被限制在工作区根目录内，
// 通过 realpath 复核，挡住 ../ 和指向外面的符号链接。
//
// 这里不碰 dsh-go 桥接的任何东西，纯函数便于单测；index.js 负责把它接到面板上。
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'

import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, extname, join, resolve, sep } from 'node:path'

/** 一屏最多列这么多条，再多提示「还有 N 项」。 */
export const LIST_LIMIT = 50
/** 预览最多这么多字符（codeBlock 上限 8000，留出 JSON 余量）。 */
export const PREVIEW_CHARS = 6000
/** 预览最多读这么多字节。 */
export const PREVIEW_BYTES = 64 * 1024
/** 超过这个大小连预览都不读，免得卡住引擎。 */
export const PREVIEW_SKIP_BYTES = 512 * 1024 * 1024
/** 单个上传文件的大小上限（字节）。可用环境变量 DSH_FILES_MAX_UPLOAD_MB 覆盖，或传 options.maxBytes。 */
export const MAX_UPLOAD_BYTES = (() => {
  const mb = Number(process.env.DSH_FILES_MAX_UPLOAD_MB)
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : 8 * 1024 * 1024
})()
/** 上传落在工作区下的这个目录里，按日期分子目录（artifacts/ 下的归档区，不往工作区根目录丢东西）。 */
export const UPLOAD_DIR = 'artifacts/uploads'
/** 一次最多收这么多个文件（与 index.js 里 pickFile 的 maxFiles 对齐）。 */
export const MAX_UPLOAD_FILES = 4

/** 工作区根目录：环境变量 > DSH 工作区注册表里的第一个工作区 > 引擎 cwd。 */
export function workspaceRoot(env = process.env, homeDir = homedir()) {
  const explicit = env.DSH_WORKSPACE_ROOT
  if (typeof explicit === 'string' && explicit !== '') return explicit
  const home = env.DSH_HOME || join(homeDir, '.dsh')
  try {
    const registry = JSON.parse(readFileSync(join(home, 'storages', 'workspace.json'), 'utf8'))
    const ids = registry?.global?.workspaceIds
    const id = Array.isArray(ids) ? ids[0] : undefined
    const path = id === undefined ? undefined : registry?.tables?.workspaces?.[id]?.path
    if (typeof path === 'string' && path !== '' && existsSync(path)) return path
  } catch {
    // 没有注册表（比如手机本机引擎第一次跑）就用 cwd。
  }
  return process.cwd()
}

/**
 * 路径身份（dev:ino）。
 *
 * 2026-11-28 修复 P0-2：Node 没有 openat2(RESOLVE_BENEATH)，也没有 dirfd 相对的
 * unlinkat / renameat，所以「校验过的路径」和「真正操作的路径」之间必然有一小段窗口。
 * 这里能做实的两件事：
 *   1) 校验时记下父目录的 dev:ino，操作前再 realpath + stat 复核一次，对不上就拒绝；
 *   2) 末端一律用不跟随符号链接的调用（lstat / O_NOFOLLOW / unlink），
 *      末端被换成软链时只会失败，不会照着链接删到工作区外去。
 * 拿不准就 fail closed（返回 error:'changed'），不假装原子。残余窗口写在 README「已知限制」。
 */
const idOf = (st) => `${st.dev}:${st.ino}`

/** 目录身份；不存在/不是目录返回 undefined。 */
function dirIdentity(path) {
  try {
    const st = statSync(path)
    return st.isDirectory() ? idOf(st) : undefined
  } catch {
    return undefined
  }
}

/** 复核一个已校验过的目录：realpath 没变，而且还是同一个 inode。 */
function dirStillSame(record) {
  if (record === undefined || record.id === undefined) return false
  try {
    return realpathSync(record.dir) === record.dir && dirIdentity(record.dir) === record.id
  } catch {
    return false
  }
}

/**
 * 祖先链安全检查（2026-11-28 第二轮复审：P0-2 收口）。
 *
 * 纯 JS 拿不到 openat2(RESOLVE_BENEATH)，所以「校验过的路径」和「真正操作的路径」
 * 之间永远有一条缝。这一轮把缝换成一条**可验证的规则**，而不是再赌概率：
 *
 * - 从工作区根到目标父目录，每一级都 lstat：任何一级是软链或不是目录 → 'changed'；
 * - 任何一级对 other 可写、且不是 sticky → 'unsafe-parent'，直接拒绝这次破坏性操作。
 *   威胁模型就是「同机别人能在校验后换掉祖先目录」：祖先只有属主可写时，别人既改不了
 *   目录项也换不掉它；sticky 目录（/tmp，1777）放行 —— 别人删不掉/改不了我们的项。
 *   应用私有目录（0700）和 /tmp 都不会误伤。
 */
const PERMISSIONLESS_FS = new Set([
  0x4d44, // MSDOS_SUPER_MAGIC（vfat / msdos，SD 卡最常见）
  0x2011bab0, // exFAT
  0x5346544e, // NTFS（内核驱动）
  0x65735546, // FUSE / fuseblk（exfat-fuse、ntfs-3g 这类）
  0xff534d42, // CIFS / SMB
  0x9660, // ISO9660
  0x15013346, // UDF
  0x01021997, // 9p
])

/**
 * 这个文件系统是否「没有 POSIX 权限语义」。
 * vfat / exFAT / NTFS / FUSE 这类挂载点会把**所有**目录报成 0777，用权限位判断的话
 * 整个工作区会变成只读（2026-11-28 第三轮 F1：SD 卡用户彻底用不了）。
 * 这里按 statfs 的 magic 认，认出来就放行——它们本来就是单用户、无权限位的存储。
 */
export function noPermissionFs(type) {
  return typeof type === 'number' && PERMISSIONLESS_FS.has(type)
}

/** 放行记录只打一次，别刷屏。 */
const openAncestorNotes = new Set()

function noteOpenAncestors(reason) {
  if (openAncestorNotes.has(reason)) return
  openAncestorNotes.add(reason)
  // 没有 logger 通道，用 console.info 留一条可查的记录（面板/引擎日志里能看到）。
  console.info(`[dsh-go-files] 放行对 other 可写的祖先目录（${reason}）：该存储不报权限语义，按权限位判断会让工作区整体只读。`)
}

/**
 * 对 other 可写的这一级要不要放行。
 * - 显式开关 DSH_FILES_ALLOW_OPEN_ANCESTORS=1：给 owner 自己的逃生口；
 * - 或这一级所在的文件系统没有权限语义（见 noPermissionFs）。
 * 其余情况一律不放行。options.fsType 只给测试/诊断用，覆盖 statfs 探测结果。
 */
function openAncestorsAllowed(path, options = {}) {
  if (process.env.DSH_FILES_ALLOW_OPEN_ANCESTORS === '1') {
    noteOpenAncestors('DSH_FILES_ALLOW_OPEN_ANCESTORS=1')
    return true
  }
  let type = typeof options.fsType === 'number' ? options.fsType : undefined
  if (type === undefined) {
    try {
      type = statfsSync(path).type
    } catch {
      return false
    }
  }
  if (!noPermissionFs(type)) return false
  noteOpenAncestors(`fs 0x${type.toString(16)}`)
  return true
}

/** 单独一级祖先的判定：'changed' / 'unsafe-parent' / undefined（放行）。 */
function ancestorProblem(path, options = {}) {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return 'changed'
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return 'changed'
  const othersCanWrite = (st.mode & 0o002) !== 0
  const sticky = (st.mode & 0o1000) !== 0
  if (!othersCanWrite || sticky) return undefined
  return openAncestorsAllowed(path, options) ? undefined : 'unsafe-parent'
}

function unsafeChain(root, dir, options = {}) {
  const rel = relativeOf(root, dir)
  const chain = [root]
  if (rel !== '') {
    let current = root
    for (const part of rel.split('/')) {
      current = join(current, part)
      chain.push(current)
    }
  }
  for (const path of chain) {
    const problem = ancestorProblem(path, options)
    if (problem !== undefined) return problem
  }
  return undefined
}

/** 末端身份：不跟随符号链接，只有普通文件才算。 */
function leafIdentity(path) {
  try {
    const st = lstatSync(path)
    return st.isFile() ? idOf(st) : undefined
  } catch {
    return undefined
  }
}

/** 打开文件并用 fstat 记下 inode 身份（O_NOFOLLOW：末端是链接直接失败）。 */
function openIdentity(path) {
  let fd
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    const st = fstatSync(fd)
    return st.isFile() ? idOf(st) : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/**
 * 改动类操作（删除 / 移动）只认工作区内的普通路径：
 * 父目录做 realpath，必须落在（同样 realpath 过的）工作区根内；末段由调用方用 lstat（不跟随）检查。
 * 返回父目录真实路径 + 末段名 + 父目录身份；工作区根本身不允许被改动。
 */
function mutatePath(root, rel, options = {}) {
  if (typeof rel !== 'string' || rel === '' || rel.includes('\0') || /^[/\\]/.test(rel)) return { error: 'denied' }
  const abs = resolve(root, rel)
  if (abs === root || !isInside(root, abs)) return { error: 'denied' }
  let parent
  try {
    parent = realpathSync(dirname(abs))
  } catch {
    return { error: 'denied' }
  }
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    return { error: 'denied' }
  }
  if (!isInside(realRoot, parent)) return { error: 'denied' }
  const unsafe = unsafeChain(realRoot, parent, options)
  if (unsafe !== undefined) return { error: unsafe }
  const id = dirIdentity(parent)
  if (id === undefined) return { error: 'denied' }
  return { abs: join(parent, basename(abs)), dir: parent, id }
}

/** 移动目标目录：允许根目录（空串），必须是真实存在、位于工作区内的目录。 */
function targetDir(root, rel, options = {}) {
  let realRoot
  try {
    realRoot = realpathSync(root)
  } catch {
    return { error: 'no-target' }
  }
  const abs = rel === '' ? realRoot : resolveInside(root, rel)
  if (abs === undefined || !isInside(realRoot, abs)) return { error: 'no-target' }
  try {
    if (!statSync(abs).isDirectory()) return { error: 'no-target' }
  } catch {
    return { error: 'no-target' }
  }
  const unsafe = unsafeChain(realRoot, abs, options)
  if (unsafe !== undefined) return { error: unsafe }
  const id = dirIdentity(abs)
  return id === undefined ? { error: 'no-target' } : { dir: abs, id }
}

/** 供删除确认绑定身份用：文件当前的 dev:ino（不跟随符号链接）。 */
export function fileIdentity(root, rel, options = {}) {
  const target = mutatePath(root, rel, options)
  return target.error !== undefined ? undefined : leafIdentity(target.abs)
}

/** 供空目录删除确认绑定身份用：目录当前的 dev:ino。 */
export function folderIdentity(root, rel, options = {}) {
  const target = mutatePath(root, rel, options)
  if (target.error !== undefined) return undefined
  try {
    const st = lstatSync(target.abs)
    return st.isDirectory() && !st.isSymbolicLink() ? idOf(st) : undefined
  } catch {
    return undefined
  }
}

/** 删除文件（不跟随符号链接，符号链接直接拒绝）。返回 { name } 或 { error }。 */
export function deleteFile(root, rel, options = {}) {
  const target = mutatePath(root, rel, options)
  if (target.error !== undefined) return { error: target.error }
  const id = leafIdentity(target.abs)
  if (id === undefined) {
    let st
    try {
      st = lstatSync(target.abs)
    } catch {
      return { error: 'missing' }
    }
    // 末端被换成链接/目录：不跟随、不删除，报明确原因。
    return { error: st.isSymbolicLink() ? 'link' : 'not-file' }
  }
  // 删除确认可以带上看那一刻的 inode：同名新文件（换了 inode）不会被旧确认删掉。
  if (typeof options.expect === 'string' && options.expect !== id) return { error: 'changed' }
  if (typeof options.afterCheck === 'function') options.afterCheck() // 测试屏障：竞态演练用
  if (!dirStillSame(target) || leafIdentity(target.abs) !== id) return { error: 'changed' }
  try {
    unlinkSync(target.abs)
    return { name: basename(target.abs) }
  } catch {
    return { error: 'denied' }
  }
}

/** 删除空文件夹；非空或根目录拒绝。返回 { name } 或 { error }。 */
export function deleteEmptyFolder(root, rel, options = {}) {
  const target = mutatePath(root, rel, options)
  if (target.error !== undefined) return { error: target.error }
  let st
  try {
    st = lstatSync(target.abs)
  } catch {
    return { error: 'missing' }
  }
  if (st.isSymbolicLink()) return { error: 'link' }
  if (!st.isDirectory()) return { error: 'not-dir' }
  const id = idOf(st)
  if (typeof options.expect === 'string' && options.expect !== id) return { error: 'changed' }
  if (typeof options.afterCheck === 'function') options.afterCheck() // 测试屏障：竞态演练用
  if (!dirStillSame(target)) return { error: 'changed' }
  try {
    // 复核还是刚才看过的那个目录，再确认它是空的，才删。
    if (idOf(lstatSync(target.abs)) !== id) return { error: 'changed' }
    if (readdirSync(target.abs).length > 0) return { error: 'not-empty' }
    rmdirSync(target.abs)
    return { name: basename(target.abs) }
  } catch {
    return { error: 'denied' }
  }
}

/**
 * 回滚目标：只有确认目标仍是我们刚 link 的那个 inode 才删，别误删别人换上去的文件。
 * 返回 'ok'（删掉了/本来就不是我们的，没留我们的孤儿）或 'failed'（删不动）。
 * 2026-11-28 第二轮复审 N3：以前回滚失败静默返回 source-changed，用户会在目标目录里
 * 发现一份自己没放过去的副本却不知道。现在失败要能区分出来。
 */
function rollbackDest(dest, id) {
  try {
    if (idOf(lstatSync(dest)) === id) {
      unlinkSync(dest)
      return 'ok'
    }
    // 目标已经不是我们的（被改名/被换掉）：不删，但也没有我们的孤儿留在这个名字上。
    return 'kept'
  } catch {
    return 'failed'
  }
}

/**
 * 把文件移动到工作区里的目标目录（同盘 link + unlink；不覆盖同名文件）。
 * 返回 { name, dir } 或 { error }。
 *
 * 2026-11-27 全检 P1：原来 spawnSync('python3', ...) 走 PATH 能被劫持，改成 Node 原生。
 * 2026-11-28 修复 P0-1：link / unlink 是两次独立调用，中间源路径可能被别的进程换成
 * 新文件；那时 unlink 删掉的就是别人的新数据。现在 link 之前先用 open+fstat 记下源
 * 的 dev:ino，删源之前再比对一次——对不上就不删，回滚目标（同样先比 inode 再删）并
 * 返回 error:'source-changed'。Node 的 fs.renameSync 没有 RENAME_NOREPLACE，
 * pure JS 里做不到单系统调用原子移动，所以这里守住的是「不丢数据」而不是「原子」。
 * 崩溃语义（已知取舍）：link 与 unlink 之间被杀会留下「源 + 目标」两份同样的文件，
 * 不会覆盖已有目标、也不会丢数据；目标已存在时重试会报 exists，需要人工删掉其中一份。
 */
export function moveFile(root, rel, targetRel, options = {}) {
  const src = mutatePath(root, rel, options)
  if (src.error !== undefined) return { error: src.error }
  const dir = targetDir(root, typeof targetRel === 'string' ? targetRel : '', options)
  if (dir.error !== undefined) return { error: dir.error }
  let st
  try {
    st = lstatSync(src.abs)
  } catch {
    return { error: 'missing' }
  }
  if (st.isSymbolicLink()) return { error: 'link' }
  if (!st.isFile()) return { error: 'not-file' }
  if (src.dir === dir.dir) return { error: 'same-dir' }
  const dest = join(dir.dir, basename(src.abs))
  if (typeof options.afterResolve === 'function') options.afterResolve() // 测试屏障：目录被换走
  // lstat 与 link 之间源也可能被换掉：先打开拿 inode，link 之后再比一次。
  const srcId = openIdentity(src.abs)
  if (srcId === undefined) return { error: 'missing' }
  // 这里才是「link 会不会落到工作区外」的关键：源父目录和目标目录都得还是我们校验过的那个。
  if (!dirStillSame(src) || !dirStillSame(dir)) return { error: 'changed' }
  try {
    linkSync(src.abs, dest)
  } catch (e) {
    if (e && e.code === 'EEXIST') return { error: 'exists' }
    // 源在中途被对方移走：link 报 ENOENT，语义是「文件已经不在了」而不是「不支持」。
    if (e && e.code === 'ENOENT') return { error: 'missing' }
    return { error: 'unsupported' }
  }
  if (typeof options.afterLink === 'function') options.afterLink() // 测试屏障：竞态演练用
  // 删源之前：源路径必须还是我们刚 link 的那个 inode，否则不删（它是别人的新文件）。
  if (!dirStillSame(src) || openIdentity(src.abs) !== srcId) {
    return { error: rollbackDest(dest, srcId) === 'failed' ? 'source-changed-orphan' : 'source-changed' }
  }
  try {
    unlinkSync(src.abs)
  } catch {
    // 源没删掉 + 目标也没回滚掉 = 这份文件同时挂在两个名字上，必须让调用方知道。
    return { error: rollbackDest(dest, srcId) === 'failed' ? 'left-both' : 'unsupported' }
  }
  return { name: basename(dest), dir: relativeOf(root, dir.dir) }
}

/** 原生列表里显示的短名字：去控制字符/换行，最多 80 字。 */
export function safeLabel(raw) {
  const text = String(raw ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\r\n\t]/g, ' ')
    .trim()
  const chars = [...text]
  return chars.length > 80 ? `${chars.slice(0, 79).join('')}…` : text
}

/** 工作区里不显示的内部目录。 */
const SKIP = new Set(['.git'])
/** 上传临时文件名前缀（见 publishFile）；这种半成品不进列表。 */
const UPLOAD_TEMP_PREFIX = '.upload-'
/** eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u001f\u007f]/g

/** 解析工作区根目录，取真实路径（符号链接也展开）。 */
export function rootOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

// 2026-11-28 修复 P2-7：工作区显式配成 `/` 时 `root + sep` 变成 `//`，前缀判断会把
// 所有子路径判成越界（`resolveInside('/', 'tmp')` → undefined）。补分隔符前先看有没有。
const isInside = (root, path) => {
  if (path === root) return true
  const base = root.endsWith(sep) ? root : root + sep
  return path.startsWith(base)
}

/** 相对路径 -> 绝对路径；越界、指向外面、不存在都返回 undefined。 */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || /^[/\\]/.test(rel)) return undefined
  const abs = resolve(root, rel || '.')
  if (!isInside(root, abs)) return undefined
  try {
    const real = realpathSync(abs)
    return isInside(root, real) ? real : undefined
  } catch {
    // A missing leaf can still have an existing ancestor symlink to outside.
    // Check the nearest resolvable ancestor before returning a missing path.
    let parent = dirname(abs)
    while (isInside(root, parent)) {
      try {
        return isInside(root, realpathSync(parent)) ? abs : undefined
      } catch {
        if (parent === root) break
        parent = dirname(parent)
      }
    }
    return undefined
  }
}

/** 绝对路径 -> 工作区内的相对路径（用 / 分隔，根目录是空串）。 */
export function relativeOf(root, abs) {
  if (abs === root) return ''
  const base = root.endsWith(sep) ? root : root + sep
  const rel = abs.startsWith(base) ? abs.slice(base.length) : abs
  return rel.split(sep).join('/')
}

/** 列的目录内容：{ entries, total, more, totalDir, totalFile } 或 { error }。 */
export function listDir(root, rel) {
  const abs = resolveInside(root, rel)
  if (abs === undefined) return { error: 'denied' }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { error: 'missing' }
  }
  if (!st.isDirectory()) return { error: 'not-directory' }

  let dirents
  try {
    // 2026-11-28 修复 P2-8：readdir 直接带类型，省掉每个条目的 lstat；stat 与
    // 子目录 readdir 只对真正要显示的前 LIST_LIMIT 项做。以前是大目录全量
    // lstat+stat、每个子目录再 readdir 一遍，同步阻塞引擎。
    dirents = readdirSync(abs, { withFileTypes: true })
  } catch {
    return { error: 'denied' }
  }

  const rows = []
  for (const entry of dirents) {
    const name = entry.name
    if (SKIP.has(name)) continue
    // 上传写到一半被杀留下的临时名：不作为数据展示（2026-11-28 第二轮 N4）。
    if (name.startsWith(UPLOAD_TEMP_PREFIX)) continue
    const childAbs = join(abs, name)
    const link = entry.isSymbolicLink()
    let dir = entry.isDirectory()
    let usable = true
    if (link) {
      // 软链先过 realpath 边界，再 stat / 统计子项；否则只是列出工作区根目录，
      // 也会跟随指向外部的目录链接并泄露其中的条目数。
      usable = resolveInside(root, relativeOf(root, childAbs)) !== undefined
      if (usable) {
        try {
          dir = statSync(childAbs).isDirectory()
        } catch {
          dir = false
        }
      } else {
        dir = false
      }
    }
    rows.push({ name, childAbs, dir, link, usable })
  }

  rows.sort((a, b) => (a.dir === b.dir
    ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    : a.dir ? -1 : 1))

  const entries = rows.slice(0, LIST_LIMIT).map((row) => {
    let size = 0
    let mtime = 0
    let count
    if (row.dir) {
      try {
        count = readdirSync(row.childAbs).filter((item) => !SKIP.has(item)).length
      } catch {
        count = undefined
      }
    } else if (!row.link || row.usable) {
      try {
        const info = statSync(row.childAbs)
        size = info.size ?? 0
        mtime = info.mtimeMs ?? 0
      } catch {
        size = 0
      }
    }
    return {
      name: row.name,
      // 2026-11-27 全检 P2：显示名必须清洗——磁盘文件名可以带换行/控制字符，
      // 原样塞进原生列表会打乱整个面板布局。rel 仍是原名（操作用），title 用 label。
      label: safeLabel(row.name),
      rel: relativeOf(root, row.childAbs),
      dir: row.dir,
      link: row.link,
      size,
      mtime,
      count,
    }
  })

  return {
    entries,
    total: rows.length,
    more: Math.max(0, rows.length - LIST_LIMIT),
    totalDir: rows.reduce((n, row) => n + (row.dir ? 1 : 0), 0),
    totalFile: rows.reduce((n, row) => n + (row.dir ? 0 : 1), 0),
  }
}

/** 文件预览：{ text, bytes, truncated, language } 或 { error, bytes? }。 */
export function previewFile(root, rel) {
  const abs = resolveInside(root, rel)
  if (abs === undefined) return { error: 'denied' }
  let st
  try {
    st = statSync(abs)
  } catch {
    return { error: 'missing' }
  }
  if (st.isDirectory()) return { error: 'directory' }
  // FIFO / 设备 / socket 打开或读取会卡死引擎：只预览普通文件。
  if (!st.isFile()) return { error: 'not-file' }
  const bytes = st.size
  const mtime = st.mtimeMs
  if (bytes > PREVIEW_SKIP_BYTES) return { error: 'too-large', bytes, mtime }

  let fd
  try {
    // O_NONBLOCK：即使 stat 与 open 之间被换成 FIFO 也不会卡在 open；O_NOFOLLOW 挡住末端软链。
    // fstat 再确认一次类型与 inode 身份（2026-11-28 P0-2：末端被换掉就别读，报「变了」）。
    fd = openSync(abs, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW)
    const opened = fstatSync(fd)
    if (!opened.isFile()) return { error: 'not-file' }
    if (idOf(opened) !== idOf(st)) return { error: 'changed' }
    const want = Math.min(bytes, PREVIEW_BYTES)
    const buf = Buffer.alloc(want)
    let got = 0
    while (got < want) {
      const n = readSync(fd, buf, got, want - got, got)
      if (n <= 0) break
      got += n
    }
    const data = buf.subarray(0, got)
    if (data.includes(0)) return { error: 'binary', bytes, mtime, language: languageOf(abs) }
    const decoded = data.toString('utf8')
    // 没有 NUL 的二进制（PDF、部分压缩包）靠替换字符/控制字符比例认出来。
    const bad = (decoded.match(/\uFFFD/g) ?? []).length
    const control = (decoded.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f]/g) ?? []).length
    if (bad > Math.max(2, decoded.length * 0.02) || control > Math.max(2, decoded.length * 0.05)) {
      return { error: 'binary', bytes, mtime, language: languageOf(abs) }
    }
    const chars = [...decoded]
    const truncated = bytes > data.length || chars.length > PREVIEW_CHARS
    return {
      text: chars.slice(0, PREVIEW_CHARS).join(''),
      bytes,
      mtime,
      truncated,
      language: languageOf(abs),
    }
  } catch {
    return { error: 'denied' }
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/** 本地日期目录名，例如 2026-11-20。 */
export function dateFolder(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** 手机传来的名字只当显示名：去掉路径和不可见字符，截断，空名兜底。 */
export function safeName(raw) {
  const base = String(raw ?? '').split(/[\\/]/).at(-1) ?? ''
  const name = base.replace(CONTROL, '').trim().replace(/^\.+$/, '')
  const cut = [...name].slice(0, 100).join('')
  return cut === '' ? 'file' : cut
}

/** 同名时加序号，绝不覆盖已有文件。 */
export function uniquePath(dir, name) {
  const ext = extname(name)
  const stem = ext === '' ? name : name.slice(0, -ext.length)
  let candidate = join(dir, name)
  for (let i = 2; existsSync(candidate) && i < 1000; i += 1) {
    candidate = join(dir, `${stem} (${i})${ext}`)
  }
  return candidate
}

/** 目录 fsync：让刚发布的名字真正落盘。失败不阻止上传（数据本身已经 fsync 过）。 */
function syncDir(dir) {
  let fd
  try {
    fd = openSync(dir, fsConstants.O_RDONLY)
    fsyncSync(fd)
  } catch {
    /* 有些文件系统不支持目录 fsync，忽略 */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* 忽略关闭失败 */
      }
    }
  }
}

/**
 * 上传落盘：先写同目录的随机临时名（wx + fsync），再用 link 做「不覆盖的原子发布」，
 * 最后删临时名。
 * 2026-11-28 修复 P1-1：以前直接 writeFileSync 到最终名，写一半（磁盘满/被杀/掉电）
 * 会留下名字正确、内容是半截的文件，重试还会另起一个名字。现在最终名只在内容完整
 * 并 fsync 过之后才出现；失败只留 `.upload-*.part` 临时文件（不进列表、可清理）。
 */
function publishFile(dir, name, data) {
  const temp = join(dir, `.upload-${randomUUID()}.part`)
  try {
    let fd
    try {
      fd = openSync(temp, 'wx')
      writeFileSync(fd, data)
      fsyncSync(fd)
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd)
        } catch {
          /* 忽略关闭失败 */
        }
      }
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = uniquePath(dir, name)
      try {
        linkSync(temp, target)
        syncDir(dir)
        return target
      } catch (e) {
        if (e && e.code === 'EEXIST') continue // 名字被别人抢先占了，换下一个序号
        throw e
      }
    }
    throw new Error('name collision')
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      /* 已发布或尚未创建 */
    }
  }
}

/**
 * 把选中的文件写进工作区 artifacts/uploads/<日期>/（目录不存在时连父目录一起建）。
 * readFn(handle) 由调用方提供（面板回调里是 ctx.dshGo.readPickedFile）。
 * 返回 { saved: [{ name, bytes }], failed: [{ name }], folder }。
 */
export function savePicked(files, readFn, options = {}) {
  const root = options.root
  const folder = options.folder ?? `${UPLOAD_DIR}/${dateFolder(options.now)}`
  const dir = join(root, folder)
  const picked = Array.isArray(files) ? files : []
  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_UPLOAD_BYTES
  const maxFiles = Number.isFinite(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : MAX_UPLOAD_FILES
  // 2026-11-28 修复 P2-10：选择器的 maxFiles 只是软约束，桥接回调可能送来更多；
  // 个数和合计字节在这里自己也核一遍。合计按 README 的「一次 ≤ 16 MiB」= 单文件上限 × 2
  // （第二轮 N8c：以前是 × maxFiles = 32 MiB，与文档不符）。
  const maxTotal = maxBytes * 2
  const failAll = (code = 'mkdir') => ({ saved: [], failed: picked.map((file) => ({ name: safeName(file?.name) })), folder, error: code })
  // 建目录前后各验一次：目标目录（或已存在的祖先）的真实路径必须在工作区根内，挡住 uploads -> 外部 的符号链接；
  // 祖先链还要跑一遍 unsafeChain —— 祖先对 other 可写就意味着别人能换掉它（第二轮：P0-2 收口）。
  let realRoot
  try {
    realRoot = realpathSync(root)
    let probe = dir
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const probeReal = realpathSync(probe)
    if (!isInside(realRoot, probeReal)) return failAll()
    // 祖先里有普通文件挡路 → 就是「建不出目录」，跟权限无关，仍报 mkdir。
    let probeStat
    try {
      probeStat = statSync(probeReal)
    } catch {
      return failAll()
    }
    if (!probeStat.isDirectory()) return failAll()
    const unsafeProbe = unsafeChain(realRoot, probeReal, options)
    if (unsafeProbe !== undefined) return failAll(unsafeProbe)
    // 显式 0755：别让 umask=000 的机器上建出一个人人可写的上传目录。
    mkdirSync(dir, { recursive: true, mode: 0o755 })
    if (!isInside(realRoot, realpathSync(dir))) return failAll()
    const unsafeDir = unsafeChain(realRoot, realpathSync(dir), options)
    if (unsafeDir !== undefined) return failAll(unsafeDir)
  } catch {
    return failAll()
  }
  const saved = []
  const failed = []
  let total = 0
  for (const [index, file] of picked.entries()) {
    try {
      if (index >= maxFiles) throw new Error('too many files')
      if (!file || typeof file.handle !== 'string') throw new Error('bad handle')
      if (Number(file.size) > maxBytes) throw new Error('too large')
      const data = readFn(file.handle)
      if (!Buffer.isBuffer(data) || data.length === 0 || data.length > maxBytes) throw new Error('empty or too large')
      total += data.length
      if (total > maxTotal) throw new Error('total too large')
      // The picker callback can take time or change the directory; revalidate
      // after it returns and write via the resolved directory, not the old alias.
      const realDir = realpathSync(dir)
      if (!isInside(realRoot, realDir)) throw new Error('outside workspace')
      // 发布前最后一次：祖先链仍然只有属主可写，门牌号还是我们校验过的那个。
      const unsafe = unsafeChain(realRoot, realDir, options)
      if (unsafe !== undefined) throw new Error(unsafe)
      if (dirIdentity(realDir) !== dirIdentity(dir)) throw new Error('changed')
      const target = publishFile(realDir, safeName(file.name), data)
      saved.push({ name: basename(target), bytes: data.length })
    } catch {
      failed.push({ name: safeName(file?.name) })
    }
  }
  return { saved, failed, folder }
}

const LANG = new Map(Object.entries({
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript',
  json: 'json', jsonc: 'json', md: 'markdown', markdown: 'markdown',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini',
  html: 'html', htm: 'html', css: 'css', scss: 'scss', less: 'less',
  sql: 'sql', xml: 'xml', svg: 'xml', php: 'php', swift: 'swift', kt: 'kotlin',
  dockerfile: 'dockerfile', makefile: 'makefile', vue: 'vue', svelte: 'svelte',
  txt: 'text', log: 'text', csv: 'csv', diff: 'diff', patch: 'diff',
}))

/** 按扩展名猜代码块语言；猜不出就不写。 */
export function languageOf(path) {
  const ext = extname(path).slice(1).toLowerCase()
  return LANG.get(ext)
}

/** 图标：只从 App 的图标名里挑，猜不到用通用文件图标。 */
export function iconOf(name) {
  const ext = extname(name).slice(1).toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'bmp', 'ico'].includes(ext)) return 'image'
  if (['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cc', 'cpp', 'cs', 'rb', 'php', 'sh'].includes(ext)) return 'code'
  if (['zip', 'tar', 'gz', 'tgz', '7z', 'rar', 'xz', 'bz2'].includes(ext)) return 'zip'
  if (ext === 'pdf') return 'pdf'
  if (['md', 'markdown', 'txt', 'log'].includes(ext)) return 'document'
  if (['json', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env'].includes(ext)) return 'settings'
  if (['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'video-file'
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return 'audio'
  return 'file'
}

/** 人类可读的大小。 */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
}

/** 面板里显示的修改时间：MM-DD HH:mm。 */
export function shortTime(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
