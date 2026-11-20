// 面板视图：一棵给 App 画的 JSON 组件树。浏览 = 目录列表，预览 = 文件内容。
// v2 组件只在 App 协商过（caps.components 里有）时用，老 App 退回 v1 基础组件。
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

/** 面板入口：有预览中的文件就画文件，否则画目录。 */
export function panelView(state, root, caps) {
  return state?.file ? fileView(state, root, caps) : browseView(state ?? {}, root, caps)
}

function action(label, id, extra = {}) {
  return { label, action: id, ...extra }
}

export function browseView(state, root, caps) {
  const zh = zhOf(caps)
  const v2 = canUseV2(caps)
  const dir = typeof state?.dir === 'string' ? state.dir : ''
  const listing = listDir(root, dir)
  const children = []

  if (listing.error) {
    const message = listing.error === 'missing'
      ? (zh ? '这个目录已经不在了' : 'This folder is gone')
      : (zh ? '没有权限打开这个目录' : 'Cannot open this folder')
    children.push({ type: 'callout', text: message, tone: 'bad' })
    children.push({ type: 'actions', items: [action(zh ? '回到工作区根目录' : 'Back to workspace root', 'root', { style: 'primary' })] })
    return rootNode(v2, children, zh ? '工作区' : 'Workspace')
  }

  const pathLabel = dir === '' ? '/' : dir
  children.push({ type: 'row', children: [ { type: 'text', ...titleText(pathLabel, v2) } ] })

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
  } else {
    children.push({
      type: 'list',
      items: listing.entries.map((entry) => ({
        title: entry.name,
        subtitle: entry.dir
          ? (entry.count !== undefined
            ? (zh ? `${entry.count} 项` : `${entry.count} items`)
            : (zh ? '文件夹' : 'folder'))
          : [humanSize(entry.size), shortTime(entry.mtime)].filter(Boolean).join(' · '),
        icon: entry.link ? 'link' : entry.dir ? 'folder' : iconOf(entry.name),
        action: { id: entry.dir ? 'enter' : 'open', args: { path: entry.rel } },
      })),
    })
    if (listing.more > 0) {
      children.push({ type: 'text', ...mutedText(zh ? `还有 ${listing.more} 项没有显示` : `${listing.more} more items not shown`, v2) })
    }
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

export function fileView(state, root, caps) {
  const zh = zhOf(caps)
  const v2 = canUseV2(caps)
  const rel = typeof state?.file === 'string' ? state.file : ''
  const name = rel.split('/').at(-1) ?? rel
  const info = previewFile(root, rel)
  const children = []

  children.push({ type: 'row', children: [ { type: 'text', ...titleText(name, v2) } ] })
  children.push({ type: 'text', ...mutedText(rel, v2) })

  if (info.error) {
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
    } else {
      children.push({ type: 'codeBlock', code: info.text })
    }
    if (info.truncated) {
      children.push({ type: 'text', ...mutedText(zh ? `只显示前 ${info.text.length} 个字符` : `Showing the first ${info.text.length} characters`, v2) })
    }
  }

  children.push({
    type: 'keyValue',
    items: [
      [zh ? '大小' : 'Size', humanSize(info.bytes ?? 0)],
      ...(info.mtime ? [[zh ? '修改' : 'Modified', shortTime(info.mtime)]] : []),
    ],
  })

  const buttons = [
    action(zh ? '返回' : 'Back', 'back', v2 ? {} : { style: 'primary' }),
    action(zh ? '复制路径' : 'Copy path', 'copyPath', { style: 'plain', icon: 'copy' }),
  ]
  if (!info.error && info.text !== undefined) {
    buttons.push(action(zh ? '复制内容' : 'Copy text', 'copyText', { style: 'plain', icon: 'copy' }))
  }
  children.push({ type: 'actions', items: buttons })

  return rootNode(v2, children, name)
}
