// 图片 / 视频预览：把工作区里的媒体转成 App 能画的资源。
//
// App 的视图只能引用清单 assets 目录里的图片（asset:preview/xxx.jpg，单文件 ≤1 MiB），
// 所以这里按需把原图复制/压缩进 assets/preview/ 缓存，再交给视图。
// 视频 App 原生不能播放：抽 1 张封面 + 截一段无声小动图（gif）当预览。
import { execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { resolveInside } from './workspace.js'
import { resolveExecutable } from './exec.js'

/** App 的 asset 路由上限。 */
export const MAX_ASSET_BYTES = 1024 * 1024
/** App 看图页单边 / 总像素的软上限。
 *  2026-11-28 第二轮 A2：原来 MAX_SIDE=4096 与 MAX_PIXELS=4M 自相矛盾（4096² 是 16.7M），
 *  兜底 box 4096² 转出来的图会被自己的总像素检查删掉。现在只留一个真上限：
 *  单边 4096，总像素就取 4096²，两者不可能再打架。 */
export const MAX_SIDE = 4096
export const MAX_PIXELS = MAX_SIDE * MAX_SIDE
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

// 2026-11-27 全检 P1：原来直接 execFileSync('ffmpeg') 走 PATH，和 python3 同一个洞。
// 默认用 resolveExecutable 只认绝对路径、属主可信、非组/他用户可写的可执行文件；
// FFMPEG_PATH/FFPROBE_PATH 是人工显式配置：要求绝对路径 + 普通文件，拒绝相对路径劫持，
// 但不再检查祖先目录（/tmp 下的测试包装脚本也要能用）。
function resolveOverride(value) {
  const text = String(value ?? '').trim()
  if (!isAbsolute(text)) return undefined
  try {
    return statSync(text).isFile() ? text : undefined
  } catch {
    return undefined
  }
}
const ffmpegBin = () => resolveOverride(process.env.FFMPEG_PATH) ?? resolveExecutable('ffmpeg')
const ffprobeBin = () => resolveOverride(process.env.FFPROBE_PATH) ?? resolveExecutable('ffprobe')

function run(bin, args, timeoutMs = RUN_TIMEOUT_MS) {
  if (!bin) return undefined
  // 2026-11-28 修复 P1-4：预算要传到子进程本身。只在外层循环检查 deadline 时，
  // 一次转换就能吃掉 2.5 秒，串几次就超过面板 3 秒窗口。
  const timeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.min(RUN_TIMEOUT_MS, timeoutMs) : RUN_TIMEOUT_MS
  try {
    return execFileSync(bin, args, {
      timeout,
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

/** WebP 尺寸：RIFF 容器里按 chunk 类型取（VP8 有损 / VP8L 无损 / VP8X 扩展）。
 *  chunk 数据从偏移 20 开始；读不到返回 undefined。 */
function webpDims(buf, n) {
  if (n < 30) return undefined
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WEBP') return undefined
  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8X') {
    // 1 字节 flags + 3 字节保留，然后各 3 字节（LE，存的是 宽-1 / 高-1）
    return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
  }
  if (chunk === 'VP8L') {
    // 0x2f 签名，之后 14 位宽 + 14 位高（各减 1）
    if (buf[20] !== 0x2f) return undefined
    const bits = buf.readUInt32LE(21)
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8 ') {
    // 3 字节帧标签 + 起始码 9d 01 2a，然后 14 位宽、14 位高
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return undefined
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  return undefined
}

/** 不启动 ffprobe，从文件头读 PNG/GIF/JPEG/WebP 尺寸；读不到返回 undefined。
 *  ffprobe 对超大 PNG（边长 > 16383）会返回 0×0，不能把 0 当合规尺寸。
 *  2026-11-28 修复 P1-3：补 WebP 解析——以前 5000×4000 的 WebP 读不到尺寸，
 *  被「未知尺寸也直接复制」放过去，整张超限图扔给 App 解码。 */
export function imageHeaderDims(path) {
  let fd
  try {
    fd = openSync(path, 'r')
    const buf = Buffer.alloc(65536)
    const n = readSync(fd, buf, 0, buf.length, 0)
    if (n < 10) return undefined
    // PNG: 89 50 4E 47 ... IHDR width/height big-endian
    if (n >= 24 && buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // GIF: GIF87a/89a, width/height little-endian
    if (buf.toString('ascii', 0, 3) === 'GIF') {
      return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
    }
    // WebP: RIFF....WEBP 之后按 chunk 类型取
    const webp = webpDims(buf, n)
    if (webp !== undefined) return webp
    // JPEG: 遍历 SOF0/1/2... 段
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2
      while (i + 9 < n) {
        if (buf[i] !== 0xff) { i += 1; continue }
        const m = buf[i + 1]
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue }
        const len = buf.readUInt16BE(i + 2)
        if (len < 2) return undefined
        if ((m >= 0xc0 && m <= 0xcf) && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
        }
        i += 2 + len
      }
    }
    return undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) { try { closeSync(fd) } catch { } }
  }
}

/** 尺寸是否在 App 的软上限内。 */
export const dimsOkay = (info) => info !== undefined && info.width > 0 && info.height > 0 &&
  info.width <= MAX_SIDE && info.height <= MAX_SIDE && info.width * info.height <= MAX_PIXELS

/** 偶数（向下取，至少 2）：ffmpeg 编码偶数字段要求。 */
const evenDown = (n) => {
  const value = Math.floor(n / 2) * 2
  return value < 2 ? 2 : value
}

/**
 * 等比缩进 box 的 ffmpeg 滤镜：宽、高、总像素三条都守住。
 * 2026-11-28 修复 P1-3：以前只按宽度驱动 `scale=W:-2`，2×10000 的极窄图宽度被
 * 抬到最小 2，高度照样 10000 —— 等于没缩。现在宽高各自夹到 box 内（box 由原图
 * 阔比算出，正常图等价于等比缩放），crop 把可能的奇数边裁掉 1 像素。
 */
export function fitFilter(box) {
  const width = Math.max(2, Math.round(box.width))
  const height = Math.max(2, Math.round(box.height))
  const crop = 'crop=trunc(iw/2)*2:trunc(ih/2)*2'
  if (Math.min(width, height) >= 4) {
    // 正常比例：等比适配进 box，别逐轴夹取（5000×500 会被压成 8.19:1 的扁图）。
    return `scale=w='min(iw,${width})':h='min(ih,${height})':force_original_aspect_ratio=decrease:flags=lanczos,${crop}`
  }
  // 极端比例（2×10000 这类）：等比适配会算出 0 宽，退回逐轴夹取 —— 两边都由同一个
  // 原图比例算出来，这时也不会变形。
  return `scale=w='min(iw,${width})':h='min(ih,${height})':flags=lanczos,${crop}`
}

/** 在单边 ≤ MAX_SIDE、总像素 ≤ MAX_PIXELS 里等比缩，宽高取偶数（ffmpeg 编码要求）。 */
export function fitBox(width, height) {
  if (!(width > 0) || !(height > 0)) return undefined
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)))
  let out = { width: evenDown(width * scale), height: evenDown(height * scale) }
  // 取偶数后偶尔会多出一两个像素，压回来。
  while (out.width * out.height > MAX_PIXELS) {
    out = { width: evenDown(out.width * 0.99), height: evenDown(out.height * 0.99) }
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

/** 缓存只接受普通文件，绝不把符号链接交给 asset 路由。 */
function fileOkay(path, maxBytes = Infinity) {
  try {
    const st = lstatSync(path)
    return st.isFile() && st.size <= maxBytes
  } catch {
    return false
  }
}

/**
 * 预览/转换前复核：路径上还是刚才 statSync 看到的那个 inode。
 * 2026-11-28 修复 P0-2（缩小窗口）：校验和读取之间源文件可能被换成指向工作区外的链接，
 * 那时 ffmpeg / copyFile 会照着链接把外面的内容搬进预览缓存。对不上就不读，报 'changed'。
 * 残余窗口（最后一次 lstat 到真正 open）写在 README「已知限制」。
 */
function sameFileAs(path, stat) {
  try {
    const now = lstatSync(path)
    return now.isFile() && now.dev === stat.dev && now.ino === stat.ino
  } catch {
    return false
  }
}

function ensureCacheDir(cacheDir) {
  mkdirSync(cacheDir, { recursive: true })
  // lstat 有意不跟随：preview 本身是链接时拒绝写入。
  if (!lstatSync(cacheDir).isDirectory()) throw new Error('invalid cache directory')
}

/**
 * 同一缓存文件可能被两个引擎进程同时生成。先写唯一临时文件再 rename，
 * App 永远看不到半张图，两个转换进程也不会往同一个输出描述符里交叉写。
 */
function produceAtomically(target, produce, maxBytes = Infinity) {
  if (existsSync(target)) {
    if (fileOkay(target, maxBytes)) return true
    try {
      // 坏的常规缓存可以重建；链接/目录等异常项一律不动、不跟随。
      if (!lstatSync(target).isFile()) return false
      unlinkSync(target)
    } catch {
      return false
    }
  }
  const ext = extname(target)
  const temp = join(dirname(target), `.${basename(target, ext)}.${process.pid}.${randomUUID()}${ext}`)
  try {
    if (produce(temp) === undefined || !fileOkay(temp, maxBytes)) return false
    renameSync(temp, target)
    return fileOkay(target, maxBytes)
  } catch {
    return false
  } finally {
    try {
      unlinkSync(temp)
    } catch {
      /* 已 rename 或尚未创建 */
    }
  }
}

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
      st = lstatSync(path)
    } catch {
      continue
    }
    if (!st.isFile()) continue
    // 进行中的临时文件不占配额；崩溃留下的隐藏临时文件过期后仍可清。
    if (name.startsWith('.') && now - st.mtimeMs <= CACHE_TTL_MS) continue
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
export function prepareImage(root, rel, cacheDir, options = {}) {
  const file = resolveInside(root, rel)
  if (file === undefined) return { error: 'denied' }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { error: 'missing' }
  }
  if (!stat.isFile()) return { error: 'denied' }
  let info = options.skipProbe === true && stat.size <= MAX_ASSET_BYTES
    ? imageHeaderDims(file)
    : probe(file)
  // 2026-11-28 第二轮 A1：以前只在 info 有值但 0×0 时才补文件头解析；主机没有 ffprobe
  // 时 info 直接是 undefined，于是每张图都进转码分支 → 没有 ffmpeg 就全灭。
  if (info === undefined || info.width <= 0 || info.height <= 0) info = imageHeaderDims(file) ?? info
  // 主机有没有 ffmpeg（能不能转码）。options.canConvert 只给测试用，覆盖探测结果。
  const canConvert = typeof options.canConvert === 'boolean' ? options.canConvert : ffmpegBin() !== undefined
  const fit = info && info.width > 0 && info.height > 0 ? fitBox(info.width, info.height) : undefined
  const sourceExt = extOf(rel)
  try {
    ensureCacheDir(cacheDir)
  } catch {
    return { error: 'cache' }
  }

  // 尺寸合规、字节也合规的小图直接复制，不动像素。
  // 2026-11-28 修复 P1-3：尺寸未知不再直接复制——未知可能是没解析到的格式（以前 WebP
  // 就是这样整张 5000×4000 原样扔给 App 解码），宁可转一版有界尺寸的图。
  // 第二轮 A1：但「主机根本没有转码工具」时不能把预览变成全灭 —— 退回原样复制并标注。
  const fitsAsset = stat.size <= MAX_ASSET_BYTES
  const canCopy = fitsAsset && (dimsOkay(info) || !canConvert)
  if (canCopy) {
    const target = join(cacheDir, `${hashOf(rel, stat)}.${sourceExt === 'jpeg' ? 'jpg' : sourceExt}`)
    if (!sameFileAs(file, stat)) return { error: 'changed' }
    if (!produceAtomically(target, (temp) => {
      copyFileSync(file, temp)
      return true
    })) return { error: 'denied' }
    pruneCache(cacheDir)
    return imageResult(target, info ?? { width: 0, height: 0 }, stat.size)
  }
  if (!canConvert) {
    // 装不下 1 MiB 又没工具转码：如实报「缺工具」，别谎报文件坏了。
    return { error: 'no-tools' }
  }

  // 太大 / 尺寸超限：逐级压到能放进 1 MiB。
  const target = join(cacheDir, `${hashOf(rel, stat)}.jpg`)
  if (!fileOkay(target, MAX_ASSET_BYTES)) {
    // 先按合规 box 压；万一还是超过 1 MiB 就把 box 逐级减半，最后退到 640×640。
    // 尺寸未知时用 2048² 兜底（≤ MAX_PIXELS，也不会因为顶满单边把比例弄坏）。
    const box = fit ?? { width: 2048, height: 2048 }
    const boxes = [
      box,
      { width: evenDown(box.width / 2), height: evenDown(box.height / 2) },
      { width: evenDown(box.width / 4), height: evenDown(box.height / 4) },
      { width: 640, height: 640 },
    ].filter((item, index, all) => all.findIndex((other) => other.width === item.width && other.height === item.height) === index)
    let made = false
    for (const boxTarget of boxes) {
      if (!sameFileAs(file, stat)) return { error: 'changed' }
      made = produceAtomically(target, (temp) =>
        run(ffmpegBin(), ['-y', '-v', 'error', '-i', file, '-frames:v', '1', '-vf', fitFilter(boxTarget), '-q:v', '4', temp],
          options.timeoutMs), MAX_ASSET_BYTES)
      if (made) break
    }
    if (!made) return { error: 'convert-failed' }
  }
  const dims = probe(target) ?? { width: 0, height: 0 }
  // 输出也核一次尺寸：滤镜没生效/参数写错时宁可不出图，也不把超限图交给 App。
  if (dims.width > 0 && dims.height > 0 && !dimsOkay(dims)) {
    try {
      unlinkSync(target)
    } catch {
      /* 删不掉就算了，下次重建 */
    }
    return { error: 'convert-failed' }
  }
  pruneCache(cacheDir)
  return imageResult(target, dims, stat.size)
}

function imageResult(target, dims, originalBytes) {
  const known = dims.width > 0 && dims.height > 0
  return {
    kind: 'image',
    asset: assetUrl(target),
    width: known ? dims.width : 0,
    height: known ? dims.height : 0,
    aspect: known ? dims.width / dims.height : undefined,
    bytes: originalBytes,
    // 「原样复制、尺寸没核」的标注：主机缺 ffprobe 时它会为 true。
    dimsUnknown: !known,
  }
}

/**
 * 视频预览：封面（jpg）+ 前几秒的无声小动图（gif，≤1 MiB）；
 * 动图压不进 1 MiB 就只留封面。
 * 返回 { kind:'video', poster, gif?, width, height, duration, aspect, bytes } 或 { error }。
 */
export function prepareVideo(root, rel, cacheDir, options = {}) {
  const file = resolveInside(root, rel)
  if (file === undefined) return { error: 'denied' }
  let stat
  try {
    stat = statSync(file)
  } catch {
    return { error: 'missing' }
  }
  if (!stat.isFile()) return { error: 'denied' }
  // 视频预览必须转码；主机没 ffmpeg 时如实说「缺工具」，别报成文件损坏。
  if (ffmpegBin() === undefined) return { error: 'no-tools' }
  const info = probe(file) ?? { width: 0, height: 0, duration: 0 }
  try {
    ensureCacheDir(cacheDir)
  } catch {
    return { error: 'cache' }
  }
  const hash = hashOf(rel, stat)

  const poster = join(cacheDir, `${hash}-poster.jpg`)
  if (!fileOkay(poster, MAX_ASSET_BYTES)) {
    if (!sameFileAs(file, stat)) return { error: 'changed' }
    // 2026-11-28 修复 P2-4：以前不管多短都 seek 到至少 0.5 秒，0.2 秒的视频抽不出封面。
    // 现在 seek 限在片长内；仍抽不到就退回第一帧（不加 -ss）。
    const at = info.duration > 0 ? Math.min(Math.max(info.duration / 3, 0), Math.max(0, info.duration - 0.1)) : 0
    const box = (info.width > 0 && info.height > 0 ? fitBox(info.width, info.height) : undefined) ?? { width: 1280, height: 720 }
    const posterOf = (seek) => produceAtomically(poster, (temp) => run(ffmpegBin(), [
      '-y', '-v', 'error',
      ...(seek > 0 ? ['-ss', seek.toFixed(3)] : []),
      '-i', file, '-frames:v', '1', '-vf', fitFilter(box), '-q:v', '4', temp,
    ], options.timeoutMs), MAX_ASSET_BYTES)
    if (!(posterOf(at) || posterOf(0))) return { error: 'convert-failed' }
  }

  // 高分辨率视频解码慢，只给封面（动图可能拖过 3 秒的调用窗口）。
  const huge = info.width * info.height > 1920 * 1080
  let gif
  const gifPath = join(cacheDir, `${hash}-loop.gif`)
  if (!huge) {
    if (fileOkay(gifPath, MAX_ASSET_BYTES)) {
      gif = gifPath
    } else {
      if (!sameFileAs(file, stat)) return { error: 'changed' }
      const start = Math.min(info.duration / 6, 2)
      const made = produceAtomically(gifPath, (temp) => run(ffmpegBin(), ['-y', '-v', 'error', '-ss', String(start), '-t', '2', '-i', file,
        '-vf', 'fps=5,scale=320:-2:flags=lanczos', '-loop', '0', temp], options.timeoutMs), MAX_ASSET_BYTES)
      if (made) gif = gifPath
    }
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

/**
 * 目录里的图片缩略图：给列表页用。图片多的目录有时间预算，到点就停。
 * 返回 [{ asset, name }]。
 */
export function prepareFolderThumbs(root, rel, cacheDir, options = {}) {
  const limit = options.limit ?? 24
  const deadline = Date.now() + (options.budgetMs ?? 900)
  // 2026-11-28 修复 P1-4：预算要按「剩余时间」传给每次转换，不能只在图片之间看一眼。
  const remaining = () => deadline - Date.now()
  const abs = resolveInside(root, rel)
  if (abs === undefined) return []
  let names
  try {
    names = readdirSync(abs)
  } catch {
    return []
  }
  const items = []
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))) {
    if (items.length >= limit || remaining() <= 0) break
    if (mediaKind(name) !== 'image') continue
    let st
    try {
      st = statSync(join(abs, name))
    } catch {
      continue
    }
    if (!st.isFile()) continue
    const childRel = rel === '' ? name : `${rel}/${name}`
    // 剩余不足 200ms：启动一次 ffmpeg 也来不及收尾，直接停。
    if (remaining() < 200) break
    const result = prepareImage(root, childRel, cacheDir, { skipProbe: true, timeoutMs: remaining() })
    if (!result.error) items.push({ asset: result.asset, name, rel: childRel, bytes: st.size, mtime: st.mtimeMs })
  }
  return items
}

/**
 * 图片预览 + 同目录图片图集：打开的那张排第一，最多 limit 张，
 * 超过时间预算就停手（面板调用只有 3 秒窗口）。
 * 返回 { opened, items: [{ asset, name, aspect }] }。
 */
export function prepareImageGallery(root, rel, cacheDir, options = {}) {
  const limit = options.limit ?? 9
  const deadline = Date.now() + (options.budgetMs ?? 1200)
  const remaining = () => deadline - Date.now()
  const opened = prepareImage(root, rel, cacheDir, { timeoutMs: remaining() })
  if (opened.error) return { opened, items: [] }
  const items = [{ asset: opened.asset, name: basename(rel), aspect: opened.aspect }]
  if (items.length >= limit || remaining() <= 0) return { opened, items }
  const abs = resolveInside(root, rel)
  let names = []
  try {
    names = abs === undefined ? [] : readdirSync(dirname(abs))
  } catch {
    names = []
  }
  const folder = abs === undefined ? '' : dirname(rel) === '.' ? '' : dirname(rel)
  for (const name of names.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))) {
    if (items.length >= limit || remaining() < 200) break
    if (name === basename(rel) || mediaKind(name) !== 'image') continue
    const childRel = folder === '' ? name : `${folder}/${name}`
    const result = prepareImage(root, childRel, cacheDir, { timeoutMs: remaining() })
    if (result.error) continue
    items.push({ asset: result.asset, name, aspect: result.aspect })
  }
  return { opened, items }
}

/** 图片 / 视频统一入口：不是媒体就返回 undefined。 */
export function prepareMedia(root, rel, cacheDir, options = {}) {
  const kind = mediaKind(rel)
  if (kind === undefined) return undefined
  return kind === 'image' ? prepareImage(root, rel, cacheDir, options) : prepareVideo(root, rel, cacheDir, options)
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
