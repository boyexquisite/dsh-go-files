// 工作区文件系统：只读浏览 + 上传落盘。全部路径都被限制在工作区根目录内，
// 通过 realpath 复核，挡住 ../ 和指向外面的符号链接。
//
// 这里不碰 dsh-go 桥接的任何东西，纯函数便于单测；index.js 负责把它接到面板上。
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname, join, resolve, sep } from 'node:path'

/** 一屏最多列这么多条，再多提示「还有 N 项」。 */
export const LIST_LIMIT = 50
/** 预览最多这么多字符（codeBlock 上限 8000，留出 JSON 余量）。 */
export const PREVIEW_CHARS = 6000
/** 预览最多读这么多字节。 */
export const PREVIEW_BYTES = 64 * 1024
/** 超过这个大小连预览都不读，免得卡住引擎。 */
export const PREVIEW_SKIP_BYTES = 512 * 1024 * 1024
/** 上传落在工作区下的这个目录里，按日期分子目录。 */
export const UPLOAD_DIR = 'uploads'

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
    if (typeof path === 'string' && path !== '') return path
  } catch {
    // 没有注册表（比如手机本机引擎第一次跑）就用 cwd。
  }
  return process.cwd()
}

/** 工作区里不显示的内部目录。 */
const SKIP = new Set(['.git'])
/** eslint-disable-next-line no-control-regex */
const CONTROL = /[\u0000-\u001f\u007f]/

/** 解析工作区根目录，取真实路径（符号链接也展开）。 */
export function rootOf(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

const isInside = (root, path) => path === root || path.startsWith(root + sep)

/** 相对路径 -> 绝对路径；越界、指向外面、不存在都返回 undefined。 */
export function resolveInside(root, rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || /^[/\\]/.test(rel)) return undefined
  const abs = resolve(root, rel || '.')
  if (!isInside(root, abs)) return undefined
  try {
    const real = realpathSync(abs)
    return isInside(root, real) ? real : undefined
  } catch {
    // 不存在（或符号链接断了）时还看不出越界，交给上层报 missing。
    return abs
  }
}

/** 绝对路径 -> 工作区内的相对路径（用 / 分隔，根目录是空串）。 */
export function relativeOf(root, abs) {
  if (abs === root) return ''
  const rel = abs.startsWith(root + sep) ? abs.slice(root.length + 1) : abs
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

  let names
  try {
    names = readdirSync(abs)
  } catch {
    return { error: 'denied' }
  }

  const rows = names.filter((name) => !SKIP.has(name)).map((name) => {
    const childAbs = join(abs, name)
    let linkStat
    let targetStat
    try {
      linkStat = lstatSync(childAbs)
    } catch {
      linkStat = undefined
    }
    try {
      targetStat = statSync(childAbs)
    } catch {
      targetStat = undefined
    }
    const target = targetStat ?? linkStat
    const link = linkStat?.isSymbolicLink() === true
    const dir = target?.isDirectory() === true
    let count
    if (dir) {
      try {
        count = readdirSync(childAbs).length
      } catch {
        count = undefined
      }
    }
    return {
      name,
      rel: relativeOf(root, childAbs),
      dir,
      link,
      size: dir ? 0 : (target?.size ?? 0),
      mtime: target?.mtimeMs ?? 0,
      count,
    }
  })

  rows.sort((a, b) => (a.dir === b.dir
    ? a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
    : a.dir ? -1 : 1))

  return {
    entries: rows.slice(0, LIST_LIMIT),
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
  const bytes = st.size
  const mtime = st.mtimeMs
  if (bytes > PREVIEW_SKIP_BYTES) return { error: 'too-large', bytes, mtime }

  let fd
  try {
    fd = openSync(abs, 'r')
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
    const chars = [...data.toString('utf8')]
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

/**
 * 把选中的文件写进工作区 uploads/<日期>/。
 * readFn(handle) 由调用方提供（面板回调里是 ctx.dshGo.readPickedFile）。
 * 返回 { saved: [{ name, bytes }], failed: [{ name }], folder }。
 */
export function savePicked(files, readFn, options = {}) {
  const root = options.root
  const folder = options.folder ?? `${UPLOAD_DIR}/${dateFolder(options.now)}`
  const dir = join(root, folder)
  mkdirSync(dir, { recursive: true })
  const saved = []
  const failed = []
  for (const file of Array.isArray(files) ? files : []) {
    try {
      if (!file || typeof file.handle !== 'string') throw new Error('bad handle')
      const data = readFn(file.handle)
      if (!Buffer.isBuffer(data) || data.length === 0) throw new Error('empty')
      const target = uniquePath(dir, safeName(file.name))
      writeFileSync(target, data, { flag: 'wx' })
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
