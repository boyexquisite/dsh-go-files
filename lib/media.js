// 图片 / 视频预览：把工作区里的媒体转成 App 能画的资源。
//
// App 的视图只能引用清单 assets 目录里的图片（asset:preview/xxx.jpg，单文件 ≤1 MiB），
// 所以这里按需把原图复制/压缩进 assets/preview/ 缓存，再交给视图。
// 视频 App 原生不能播放：抽 1 张封面 + 截一段无声小动图（gif）当预览。
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { resolveInside } from './workspace.js'

/** App 的 asset 路由上限。 */
export const MAX_ASSET_BYTES = 1024 * 1024
/** App 看图页单边 / 总像素的软上限。 */
export const MAX_SIDE = 4096
export const MAX_PIXELS = 4_000_000
/** 缓存最多留多少个文件、几天不用就删。 */
export const CACHE_KEEP = 64
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000
/** 外部命令一次最多等这么久，别拖垮面板（视图/回调 3 秒上限）。 */
const RUN_TIMEOUT_MS = 2500

export const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif'])
export const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', '3gp', 'ts', 'flv'])

const extOf = (path) => extname(path).slice(1).toLowerCase()

/** 这个相对路径是什么媒体类型。 */
export function mediaKind(rel) {
  const ext = extOf(rel)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return undefined
}

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg'
const ffprobeBin = () => process.env.FFPROBE_PATH || 'ffprobe'

function run(bin, args) {
  try {
    return execFileSync(bin, args, {
      timeout: RUN_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 1024 * 1024,
    })
  } catch {
    return undefined
  }
}

/** 宽高、时长（秒）。取不到就返回 undefined。 */
export function probe(path) {
  const out = run(ffprobeBin(), [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,duration:format=duration',
    '-of', 'json',
    path,
  ])
  if (out === undefined) return undefined
  try {
    const parsed = JSON.parse(String(out))
    const stream = parsed.streams?.[0] ?? {}
    const duration = Number(stream.duration ?? parsed.format?.duration)
    const width = Number(stream.width)
    const height = Number(stream.height)
    return {
      width: Number.isFinite(width) && width > 0 ? width : 0,
      height: Number.isFinite(height) && height > 0 ? height : 0,
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0,
    }
  } catch {
    return undefined
  }
}

/** 在单边 ≤ MAX_SIDE、总像素 ≤ MAX_PIXELS 里等比缩，宽高取偶数（ffmpeg 编码要求）。 */
export function fitBox(width, height) {
  if (!(width > 0) || !(height > 0)) return undefined
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  const even = (n) => Math.max(2, Math.floor(n / 2) * 2)
  let out = { width: even(width * scale), height: even(height * scale) }
  // 取偶数后偶尔会多出一两个像素，压回来。
  while (out.width * out.height > MAX_PIXELS) {
    out = { width: even(out.width * 0.99), height: even(out.height * 0.99) }
  }
  return out
}

/** 缓存目录：默认插件自己的 assets/preview。 */
export function cacheDirOf(pluginDir) {
  return join(pluginDir, 'assets', 'preview')
}

const hashOf = (rel, stat) => createHash('sha1')
  .update(`${rel}\0${stat.size}\0${Math.floor(stat.mtimeMs)}`)
  .digest('hex')
  .slice(0, 24)

// 缓存目录固定是清单 assets 目录下的 preview/，asset: 路径就按这个相对路径写。
const assetUrl = (file) => `asset:preview/${basename(file)}`

/** 删掉过期和超量的缓存，失败就算了。 */
export function pruneCache(cacheDir, now = Date.now()) {
  let names
  try {
    names = readdirSync(cacheDir)
  } catch {
    return
  }
  const rows = []
  for (const name of names) {
    const path = join(cacheDir, name)
    let st
    try {
      st = statSync(path)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    if (now - st.mtimeMs > CACHE_TTL_MS) {
      try {
        unlinkSync(path)
      } catch {
        /* 忽略 */
      }
      continue
    }
    rows.push({ path, mtime: st.mtimeMs })
  }
  if (rows.length <= CACHE_KEEP) return
  rows.sort((a, b) => a.mtime - b.mtime)
  for (const row of rows.slice(0, rows.length - CACHE_KEEP)) {
    try {
      unlinkSync(row.path)
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 图片预览：能直接放就复制，太大就压一版 jpg。
 * 返回 { kind:'image', asset, aspect, width, height, bytes } 或 { error }。
 */
export function prepareImage(root, rel, cacheDir) {
  const file = resolveInside(root, rel)
  if (file === undefined) return { error: 'denied' }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { error: 'missing' }
  }
  if (!stat.isFile()) return { error: 'denied' }
  const info = probe(file)
  const fit = info ? fitBox(info.width, info.height) : undefined
  const sourceExt = extOf(rel)
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {
    return { error: 'cache' }
  }

  // 尺寸合规、字节也合规的小图直接复制，不动像素。
  const canCopy = stat.size <= MAX_ASSET_BYTES && (info === undefined || (info.width <= MAX_SIDE && info.height <= MAX_SIDE && info.width * info.height <= MAX_PIXELS))
  if (canCopy) {
    const target = join(cacheDir, `${hashOf(rel, stat)}.${sourceExt === 'jpeg' ? 'jpg' : sourceExt}`)
    if (!existsSync(target)) {
      try {
        copyFileSync(file, target)
      } catch {
        return { error: 'denied' }
      }
    }
    const dims = info ?? probe(target) ?? { width: 0, height: 0 }
    pruneCache(cacheDir)
    return imageResult(target, dims, stat.size)
  }

  // 太大 / 尺寸超限：逐级压到能放进 1 MiB。
  const target = join(cacheDir, `${hashOf(rel, stat)}.jpg`)
  if (!existsSync(target)) {
    // 先按合规尺寸压；万一还是超过 1 MiB 就逐级减半，最后退到 640 宽。
    const base = fit?.width ?? MAX_SIDE
    const widths = [...new Set([base, Math.round(base / 2), Math.round(base / 4), 640].filter((n) => n >= 2))]
    let made = false
    for (const width of widths) {
      const scaled = `scale=${width}:-2:flags=lanczos`
      if (run(ffmpegBin(), ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', scaled, '-q:v', '4', target]) !== undefined
        && existsSync(target) && statSync(target).size <= MAX_ASSET_BYTES) {
        made = true
        break
      }
      if (existsSync(target)) {
        try {
          unlinkSync(target)
        } catch {
          /* 忽略 */
        }
      }
    }
    if (!made) return { error: 'convert-failed' }
  }
  const dims = probe(target) ?? { width: 0, height: 0 }
  pruneCache(cacheDir)
  return imageResult(target, dims, stat.size)
}

function imageResult(target, dims, originalBytes) {
  return {
    kind: 'image',
    asset: assetUrl(target),
    width: dims.width,
    height: dims.height,
    aspect: dims.width > 0 && dims.height > 0 ? dims.width / dims.height : undefined,
    bytes: originalBytes,
  }
}

/**
 * 视频预览：封面（jpg）+ 前几秒的无声小动图（gif，≤1 MiB）；
 * 动图压不进 1 MiB 就只留封面。
 * 返回 { kind:'video', poster, gif?, width, height, duration, aspect, bytes } 或 { error }。
 */
export function prepareVideo(root, rel, cacheDir) {
  const file = resolveInside(root, rel)
  if (file === undefined) return { error: 'denied' }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { error: 'missing' }
  }
  if (!stat.isFile()) return { error: 'denied' }
  const info = probe(file) ?? { width: 0, height: 0, duration: 0 }
  try {
    mkdirSync(cacheDir, { recursive: true })
  } catch {
    return { error: 'cache' }
  }
  const hash = hashOf(rel, stat)

  const poster = join(cacheDir, `${hash}-poster.jpg`)
  if (!existsSync(poster)) {
    const at = Math.min(Math.max(info.duration / 3, 0.5), 5)
    const fitted = info.width > 0 && info.height > 0 ? fitBox(info.width, info.height)?.width : undefined
    const scaled = `scale=${fitted ?? 1280}:-2:flags=lanczos`
    const ok = run(ffmpegBin(), ['-y', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', scaled, '-q:v', '4', poster])
    if (ok === undefined || !existsSync(poster)) return { error: 'convert-failed' }
  }

  // 高分辨率视频解码慢，只给封面（动图可能拖过 3 秒的调用窗口）。
  const huge = info.width * info.height > 1920 * 1080
  let gif
  const gifPath = join(cacheDir, `${hash}-loop.gif`)
  if (!huge && !existsSync(gifPath)) {
    const start = Math.min(info.duration / 6, 2)
    run(ffmpegBin(), ['-y', '-v', 'error', '-ss', String(start), '-t', '2', '-i', file,
      '-vf', 'fps=5,scale=320:-2:flags=lanczos', '-loop', '0', gifPath])
    if (!existsSync(gifPath) || statSync(gifPath).size > MAX_ASSET_BYTES) {
      try {
        unlinkSync(gifPath)
      } catch {
        /* 忽略 */
      }
    } else {
      gif = gifPath
    }
  } else if (statSync(gifPath).size <= MAX_ASSET_BYTES) {
    gif = gifPath
  }

  pruneCache(cacheDir)
  const posterDims = probe(poster) ?? { width: 0, height: 0 }
  return {
    kind: 'video',
    poster: assetUrl(poster),
    gif: gif ? assetUrl(gif) : undefined,
    width: info.width || posterDims.width,
    height: info.height || posterDims.height,
    duration: info.duration,
    aspect: posterDims.width > 0 && posterDims.height > 0 ? posterDims.width / posterDims.height : undefined,
    bytes: stat.size,
  }
}

/** 图片 / 视频统一入口：不是媒体就返回 undefined。 */
export function prepareMedia(root, rel, cacheDir) {
  const kind = mediaKind(rel)
  if (kind === undefined) return undefined
  return kind === 'image' ? prepareImage(root, rel, cacheDir) : prepareVideo(root, rel, cacheDir)
}

/** 视频时长：1:23 / 1:02:03。 */
export function formatDuration(seconds) {
  if (!(seconds > 0)) return ''
  const total = Math.round(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`
}
