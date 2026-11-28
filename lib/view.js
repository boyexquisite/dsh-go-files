// 面板视图：一棵给 App 画的 JSON 组件树。浏览 = 目录列表，预览 = 文件内容。
// v2 组件只在 App 协商过（caps.components 里有）时用，老 App 退回 v1 基础组件。
import { formatDuration, prepareFolderThumbs } from './media.js'
import { humanSize, iconOf, listDir, previewFile, shortTime } from './workspace.js'

const zhOf = (caps) => !/^en/i.test(String(caps?.locale ?? ''))

const hasComponent = (caps, name) => Array.isArray(caps?.components) && caps.components.includes(name)

const canUseV2 = (caps) => hasComponent(caps, 'emptyState') && hasComponent(caps, 'codeBlock')

const hasFiles = (caps) => Array.isArray(caps?.features) && caps.features.includes('files')

const titleText = (text, v2) => (v2 ? { text, style: { size: 'title', weight: 'bold' } } : { text })

const mutedText = (text, v2) => (v2 ? { text, tone: 'muted', style: { size: 'caption' } } : { text, tone: 'muted' })

const rootNode = (v2, children, title) => (v2
  ? { v: 2, type: 'stack', children, ...(title ? { title } : {}) }
  : { type: 'stack', children, ...(title ? { title } : {}) })

/** 目录缩略图按目录缓存，别每次取视图都重转。 */
function thumbsOf(state, root, cacheDir) {
  const dir = typeof state?.dir === 'string' ? state.dir : ''
  if (state?.thumbs && state.thumbs.dir === dir) return state.thumbs.items
  const items = prepareFolderThumbs(root, dir, cacheDir, { limit: 24, budgetMs: 900 })
  if (state) state.thumbs = { dir, items }
  return items
}

/** 面板入口：移动选目录 > 文件预览 > 目录浏览。 */
export function panelView(state, root, caps, cacheDir) {
  if (state?.mode === 'move') return moveView(state, root, caps)
  return state?.file ? fileView(state, root, caps) : browseView(state ?? {}, root, caps, cacheDir)
}

function action(label, id, extra = {}) {
  return { label, action: id, ...extra }
}

export function browseView(state, root, caps, cacheDir) {
  const zh = zhOf(caps)
  const v2 = canUseV2(caps)
  const dir = typeof state?.dir === 'string' ? state.dir : ''
  const listing = listDir(root, dir)
  const children = []

  if (listing.error) {
    const message = listing.error === 'missing'
      ? (zh ? '这个目录已经不在了' : 'This folder is gone')
      : listing.error === 'not-directory'
        ? (zh ? '这里已经不是文件夹了' : 'This is no longer a folder')
        : (zh ? '没有权限打开这个目录' : 'Cannot open this folder')
    children.push({ type: 'callout', text: message, tone: 'bad' })
    children.push({ type: 'actions', items: [action(zh ? '回到工作区根目录' : 'Back to workspace root', 'root', { style: 'primary' })] })
    return rootNode(v2, children, zh ? '工作区' : 'Workspace')
  }

  const pathLabel = dir === '' ? '/' : dir
  children.push({ type: 'row', children: [ { type: 'text', ...titleText(displayName(pathLabel, 60), v2) } ] })

  const summary = listing.total === 0
    ? (zh ? '这个文件夹是空的' : 'This folder is empty')
    : (zh
      ? `${listing.totalDir} 个文件夹 · ${listing.totalFile} 个文件`
      : `${listing.totalDir} folders · ${listing.totalFile} files`)
  children.push({ type: 'text', ...mutedText(summary, v2) })
  if (dir === '') children.push({ type: 'text', ...mutedText(root, v2) })

  if (listing.total === 0) {
    children.push(v2
      ? { type: 'emptyState', title: zh ? '空文件夹' : 'Empty folder', icon: 'folder', message: zh ? '上传一个文件，或者去别的目录看看' : 'Upload a file or browse another folder' }
      : { type: 'text', text: zh ? '（空文件夹）' : '(empty folder)', tone: 'muted' })
    if (dir !== '') {
      children.push({ type: 'confirm', id: state.deleteDirAction ?? 'deleteDir', confirmLabel: zh ? '删除空文件夹' : 'Delete folder', cancelLabel: zh ? '取消' : 'Cancel' })
    }
  } else {
    // 图片在这一级直接出缩略图（App 的列表行只认图标，放不了自定义缩略图）。
    const thumbs = v2 && hasComponent(caps, 'gallery') && typeof cacheDir === 'string'
      ? thumbsOf(state, root, cacheDir)
      : []
    const thumbNames = new Set(thumbs.map((thumb) => thumb.name))
    const rest = listing.entries.filter((entry) => !(entry.dir === false && thumbNames.has(entry.name)))
    if (thumbs.length > 0) {
      children.push({ type: 'text', ...mutedText(zh ? `图片 · ${thumbs.length} 张` : `${thumbs.length} photos`, v2) })
      // 两列卡片：缩略图 + 文件名，点任意一张进 App 看图页。
      children.push({
        type: 'gallery',
        columns: 2,
        aspect: 1,
        items: thumbs.map((thumb) => ({
          src: thumb.asset,
          alt: thumb.name,
          caption: displayName(thumb.name, 40),
          action: { id: 'open', args: { path: thumb.rel } },
        })),
      })
      children.push({ type: 'text', ...mutedText(zh ? '点卡片全屏看，可双指缩放、保存。' : 'Tap a card for full screen, pinch to zoom, save.', v2) })
    }
    if (rest.length > 0) children.push({
      type: 'list',
      items: rest.map((entry) => ({
        title: entry.label ?? entry.name,
        subtitle: entry.dir
          ? (entry.count !== undefined
            ? (zh ? `${entry.count} 项` : `${entry.count} items`)
            : (zh ? '文件夹' : 'folder'))
          : [humanSize(entry.size), shortTime(entry.mtime)].filter(Boolean).join(' · '),
        icon: entry.link ? 'link' : entry.dir ? 'folder' : iconOf(entry.name),
        action: { id: entry.dir ? 'enter' : 'open', args: { path: entry.rel } },
      })),
    })
  }
  if (listing.more > 0) {
    children.push({ type: 'text', ...mutedText(zh ? `还有 ${listing.more} 项没有显示` : `${listing.more} more items not shown`, v2) })
  }

  if (!hasFiles(caps)) {
    children.push({ type: 'callout', text: zh
      ? '这个 App 版本不支持从手机选文件；升级 App 后这里会出现上传按钮。'
      : 'This app version cannot pick phone files; the upload button appears after an app update.', tone: 'warn' })
  }

  const primary = v2 ? {} : { style: 'primary' }
  const buttons = [
    action(zh ? '上一级' : 'Up', 'up', { style: 'plain' }),
    action(zh ? '刷新' : 'Refresh', 'refresh', { style: 'plain', icon: 'refresh' }),
  ]
  if (hasFiles(caps)) buttons.push(action(zh ? '上传文件' : 'Upload', 'upload', { icon: 'downloads', ...primary }))
  children.push({ type: 'actions', items: buttons })

  return rootNode(v2, children, zh ? '工作区' : 'Workspace')
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * 展示用文本：去掉 C0/C1 控制字符、双向控制符和零宽字符。
 * 2026-11-28 修复 P2-2：目录标题、文件标题、移动目标、成功提示以前直接用原始路径，
 * 换行会打乱面板布局，U+202E 之类还能把显示顺序伪装成别的文件名。操作参数仍用原名。
 */
const displaySafe = (raw) => String(raw ?? '')
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, '')

/** 长文件名中间截断，别让标题铺满屏。 */
export function displayName(name, max = 44) {
  const chars = [...displaySafe(name)]
  if (chars.length <= max) return chars.join('')
  const head = Math.ceil((max - 1) * 0.6)
  const tail = max - 1 - head
  return `${chars.slice(0, head).join('')}…${chars.slice(chars.length - tail).join('')}`
}

/** 图片 / 视频预览块：图走 App 看图页（点开全屏），视频给封面 + 无声动图。 */
function mediaChildren(media, name, zh, caps) {
  const out = []
  if (media.error) {
    const message = media.error === 'denied' || media.error === 'missing'
      ? (zh ? '读不到这个文件。' : 'Cannot read this file.')
      : media.error === 'no-tools'
        ? (zh ? '主机没装 ffmpeg / ffprobe，这个文件转不成预览（原文件没事）。' : 'This host has no ffmpeg/ffprobe, so this file cannot be previewed.')
        : (zh ? '这个文件转不成预览（文件损坏或预览缓存放不下）。' : 'This file could not be turned into a preview.')
    out.push({ type: 'callout', text: message, tone: 'bad' })
    return out
  }
  if (media.dimsUnknown) {
    // 第二轮 A1：主级缺 ffprobe 时按原图显示，尺寸没校验过，明说一句。
    out.push({ type: 'text', ...mutedText(zh ? '主机没有 ffprobe，这里按原图显示（尺寸未校验）。' : 'No ffprobe on this host; shown as-is, size unchecked.', canUseV2(caps)) })
  }
  const v2 = canUseV2(caps)
  const gallery = v2 && hasComponent(caps, 'gallery')
  if (media.kind === 'image') {
    if (gallery) {
      // 同目录的图拼成图集：点任意一张进 App 看图页，左右滑、双指缩放、保存。
      const items = Array.isArray(media.gallery) && media.gallery.length > 0
        ? media.gallery
        : [{ asset: media.asset, name, aspect: media.aspect }]
      out.push({
        type: 'gallery',
        columns: items.length >= 3 ? 3 : 2,
        aspect: clamp(media.aspect ?? 1, 0.5, 2),
        items: items.map((item) => ({ src: item.asset, alt: item.name })),
      })
      out.push({ type: 'text', ...mutedText(zh
        ? '点图全屏看，可双指缩放、保存；同目录的图能左右滑。'
        : 'Tap a picture for full screen, pinch to zoom, save. Swipe through the folder.', v2) })
    } else {
      out.push({ type: 'image', src: media.asset, aspect: clamp(media.aspect ?? 1, 0.25, 4) })
    }
    return out
  }
  const items = []
  if (media.gif) items.push({ src: media.gif, alt: `${name} preview`, caption: zh ? '无声动图' : 'Silent clip' })
  items.push({ src: media.poster, alt: name, caption: zh ? '封面' : 'Cover' })
  if (gallery) {
    out.push({ type: 'gallery', columns: 2, aspect: clamp(media.aspect ?? 1.6, 0.5, 2), items })
  } else {
    out.push({ type: 'image', src: media.poster, aspect: clamp(media.aspect ?? 1.6, 0.25, 4) })
  }
  out.push({ type: 'callout', tone: 'info', text: gallery
    ? (zh ? 'App 原生面板不能播放视频，这里给封面和一段无声小动图；原片还在工作区里。'
      : 'The native panel cannot play video; shown is a cover and a short silent clip. The original stays in the workspace.')
    : (zh ? 'App 原生面板不能播放视频，这里只显示封面；原片还在工作区里。'
      : 'The native panel cannot play video; only a cover is shown. The original stays in the workspace.') })
  return out
}

export function fileView(state, root, caps) {
  const zh = zhOf(caps)
  const v2 = canUseV2(caps)
  const rel = typeof state?.file === 'string' ? state.file : ''
  const name = rel.split('/').at(-1) ?? rel
  const media = state?.media
  const info = previewFile(root, rel)
  const children = []

  children.push({
    type: 'row',
    children: [{
      type: 'text',
      text: displayName(name),
      ...(v2 ? { style: { size: 'body', weight: 'semibold', maxLines: 2 } } : {}),
    }],
  })
  const folder = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
  if (folder !== '') children.push({ type: 'text', ...mutedText(displayName(folder, 60), v2) })

  if (media) {
    children.push(...mediaChildren(media, name, zh, caps))
  } else if (info.error) {
    const message = info.error === 'binary'
      ? (zh ? '二进制文件，不能预览。' : 'Binary file; no preview.')
      : info.error === 'too-large'
        ? (zh ? '文件太大，不预览了。' : 'File is too large to preview.')
        : info.error === 'directory'
          ? (zh ? '这是个文件夹。' : 'That is a folder.')
          : (zh ? '读不到这个文件。' : 'Cannot read this file.')
    children.push({ type: 'callout', text: message, tone: info.error === 'binary' || info.error === 'too-large' ? 'warn' : 'bad' })
  } else {
    if (v2 && info.language) {
      children.push({ type: 'codeBlock', code: info.text, language: info.language })
    } else if (hasComponent(caps, 'codeBlock')) {
      children.push({ type: 'codeBlock', code: info.text })
    } else {
      children.push({ type: 'text', text: info.text })
    }
    if (info.truncated) {
      children.push({ type: 'text', ...mutedText(zh ? `只显示前 ${info.text.length} 个字符` : `Showing the first ${info.text.length} characters`, v2) })
    }
  }

  const items = [[zh ? '大小' : 'Size', humanSize(info.bytes ?? media?.bytes ?? 0)]]
  if (info.mtime) items.push([zh ? '修改' : 'Modified', shortTime(info.mtime)])
  if (media?.duration > 0) items.push([zh ? '时长' : 'Length', formatDuration(media.duration)])
  if (media?.width > 0 && media?.height > 0) items.push([zh ? '分辨率' : 'Resolution', `${media.width}×${media.height}`])
  children.push({ type: 'keyValue', items })

  const buttons = [
    action(zh ? '返回' : 'Back', 'back', v2 ? {} : { style: 'primary' }),
    action(zh ? '移动到…' : 'Move to…', 'move', { style: 'plain', icon: 'folder-open' }),
    action(zh ? '复制路径' : 'Copy path', 'copyPath', { style: 'plain', icon: 'copy' }),
  ]
  if (!media && !info.error && info.text !== undefined) {
    buttons.push(action(zh ? '复制内容' : 'Copy text', 'copyText', { style: 'plain', icon: 'copy' }))
  }
  children.push({ type: 'actions', items: buttons })
  children.push({ type: 'confirm', id: state.deleteFileAction ?? 'deleteFile', confirmLabel: zh ? '删除' : 'Delete', cancelLabel: zh ? '取消' : 'Cancel' })

  return rootNode(v2, children, name)
}

/** 移动目标选择：只列文件夹，点进去选，再按「移动到这里」。 */
export function moveView(state, root, caps) {
  const zh = zhOf(caps)
  const v2 = canUseV2(caps)
  const dir = typeof state?.moveDir === 'string' ? state.moveDir : ''
  const name = typeof state?.file === 'string' ? state.file.split('/').at(-1) ?? '' : ''
  const listing = listDir(root, dir)
  const children = []

  children.push({ type: 'row', children: [ { type: 'text', ...titleText(zh ? '移动到…' : 'Move to…', v2) } ] })
  children.push({ type: 'text', ...mutedText(zh ? `文件：${displayName(name, 36)}` : `File: ${displayName(name, 36)}`, v2) })
  const where = dir === '' ? (zh ? '工作区根目录' : 'workspace root') : dir
  children.push({ type: 'text', ...mutedText(zh ? `目标：${displayName(where, 60)}` : `Target: ${displayName(where, 60)}`, v2) })

  if (listing.error) {
    children.push({ type: 'callout', text: zh ? '这个目录已经不在了' : 'This folder is gone', tone: 'bad' })
  } else {
    // 2026-11-28 修复 P2-3：底层 listDir 已经只给 LIST_LIMIT 项，这里不再二次截到 24，
    // 否则第 25 个以后的子目录在移动界面里根本选不到。
    const dirs = listing.entries.filter((entry) => entry.dir)
    if (dirs.length === 0) {
      children.push({ type: 'callout', text: zh ? '这里没有子文件夹，可以直接移动到这里。' : 'No subfolders here; you can move it here.', tone: 'info' })
    } else {
      children.push({
        type: 'list',
        items: dirs.map((entry) => ({
          title: entry.label ?? entry.name,
          subtitle: entry.count !== undefined ? (zh ? `${entry.count} 项` : `${entry.count} items`) : undefined,
          icon: 'folder',
          action: { id: 'enterMove', args: { path: entry.rel } },
        })),
      })
      if (listing.more > 0) {
        children.push({ type: 'text', ...mutedText(zh ? `还有 ${listing.more} 项没有显示` : `${listing.more} more items not shown`, v2) })
      }
    }
  }
  // 上一级 / 取消放在出错分支外面：目标目录没了也要能退出去，不能把用户困在移动模式。
  children.push({ type: 'actions', items: [
    action(zh ? '移动到这里' : 'Move here', state.moveHereAction ?? 'moveHere', v2 ? {} : { style: 'primary' }),
    action(zh ? '上一级' : 'Up', 'upMove', { style: 'plain' }),
    action(zh ? '取消' : 'Cancel', 'cancelMove', { style: 'plain' }),
  ] })
  return rootNode(v2, children, zh ? '移动到…' : 'Move to…')
}
