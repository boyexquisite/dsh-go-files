// dsh-go-workspace：dsh-go 手机里的「工作区」原生面板。
//
// 侧栏「插件」页签（以及聊天页插件弹层、全部功能）里一页工作区：
// 逛目录、看文本预览、把手机里的文件传进工作区 uploads/<日期>/。
// 所有文件操作都跑在主机引擎里，路径被限制在工作区根目录内。
import { readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDirOf, mediaKind, prepareMedia } from './media.js'
import { panelView } from './view.js'
import { previewFile, relativeOf, resolveInside, rootOf, savePicked, workspaceRoot } from './workspace.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const name = PKG.name

/** 工作区根目录：DSH 注册表里的工作区，取不到再用引擎 cwd。 */
const ROOT = rootOf(workspaceRoot())

/** 预览缓存放在插件自己的 assets/preview/ 下，App 才能用 asset: 引用。 */
const DEFAULT_CACHE = cacheDirOf(fileURLToPath(new URL('..', import.meta.url)))

const isZh = (locale) => !/^en/i.test(String(locale ?? ''))

const toast = (event, zh, en) => ({ toast: isZh(event?.locale) ? zh : en })

const parentOf = (dir) => {
  if (dir === '') return ''
  const parent = dirname(dir)
  return parent === '.' || parent === '/' ? '' : parent
}

export function apply(ctx, options = {}) {
  const root = options.root ? rootOf(options.root) : ROOT
  const cache = options.cacheDir ? options.cacheDir : DEFAULT_CACHE

  ctx.inject(['dshGo'], (ctx) => {
    /** 每个对话（以及「全部功能」）各记一份浏览位置：{ dir, file }。 */
    const states = new Map()
    const keyOf = (scope) => (typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : 'default')
    const stateOf = (scope) => {
      const key = keyOf(scope)
      let state = states.get(key)
      if (state === undefined) {
        state = { dir: '', file: null, media: undefined }
        states.set(key, state)
      }
      return state
    }

    /** 点目录 / 点文件都走这里：是目录就进，是文件就预览。 */
    const show = (scope, event) => {
      const path = typeof event?.value?.path === 'string' ? event.value.path : undefined
      if (path === undefined) return toast(event, '没有拿到路径', 'No path received')
      const abs = resolveInside(root, path)
      if (abs === undefined) return toast(event, '这个位置不在工作区里', 'That path is outside the workspace')
      let kind
      try {
        kind = statSync(abs).isDirectory() ? 'dir' : 'file'
      } catch {
        return toast(event, '打不开这个位置', 'Cannot open that path')
      }
      const rel = relativeOf(root, abs)
      const state = stateOf(scope)
      if (kind === 'dir') {
        state.dir = rel
        state.file = null
        state.media = undefined
      } else {
        state.file = rel
        // 图片 / 视频：先转成 App 能引用的资源（复制或压缩进 assets/preview）。
        try {
          state.media = mediaKind(rel) === undefined ? undefined : prepareMedia(root, rel, cache)
        } catch {
          state.media = { error: 'convert-failed' }
        }
      }
      return { refresh: true }
    }

    ctx.dshGo.panel('files', {
      view: (scope, caps) => panelView(stateOf(scope), root, caps),
      actions: {
        enter: show,
        open: show,

        up(scope, event) {
          const state = stateOf(scope)
          if (state.dir === '') return toast(event, '已经在工作区根目录', 'Already at the workspace root')
          state.dir = parentOf(state.dir)
          state.file = null
          state.media = undefined
          return { refresh: true }
        },

        root(scope) {
          const state = stateOf(scope)
          state.dir = ''
          state.file = null
          state.media = undefined
          return { refresh: true }
        },

        back(scope) {
          const state = stateOf(scope)
          state.file = null
          state.media = undefined
          return { refresh: true }
        },

        refresh() {
          return { refresh: true }
        },

        copyPath(scope, event) {
          const state = stateOf(scope)
          const path = state.file ?? state.dir
          if (path === '') return toast(event, '根目录没有路径可复制', 'The root has no path to copy')
          return { copy: path, toast: isZh(event?.locale) ? '已复制路径' : 'Path copied' }
        },

        copyText(scope, event) {
          const state = stateOf(scope)
          if (state.file === null) return toast(event, '先打开一个文件', 'Open a file first')
          const info = previewFile(root, state.file)
          if (info.text === undefined) return toast(event, '这个文件复制不了', 'This file cannot be copied')
          return { copy: info.text, toast: isZh(event?.locale) ? '已复制内容' : 'Text copied' }
        },

        /** 手机上打开系统选择器；文件随后经桥接传上来，回调 `receive`。 */
        upload() {
          return { type: 'pickFile', action: 'receive', maxFiles: 4 }
        },

        receive(scope, event) {
          const value = event?.value ?? {}
          if (value.status !== 'selected') {
            return value.status === 'cancelled'
              ? toast(event, '已取消上传', 'Upload cancelled')
              : toast(event, '选择文件失败', 'File selection failed')
          }
          let result
          try {
            result = savePicked(value.files, (handle) => ctx.dshGo.readPickedFile(handle), { root })
          } catch {
            return toast(event, '上传失败：保存不了文件', 'Upload failed: cannot save the file')
          }
          if (result.error === 'mkdir') {
            return toast(event, '上传失败：写不进工作区', 'Upload failed: cannot write to the workspace')
          }
          const { saved, failed, folder } = result
          const state = stateOf(scope)
          if (saved.length > 0) {
            state.dir = folder
            state.file = null
            state.media = undefined
          }
          if (saved.length === 0) return toast(event, '上传失败，没有文件保存下来', 'Upload failed; nothing was saved')
          const zh = isZh(event?.locale)
          const text = failed.length > 0
            ? (zh ? `上传 ${saved.length} 个，${failed.length} 个失败` : `${saved.length} uploaded, ${failed.length} failed`)
            : (zh ? `已上传 ${saved.length} 个文件到 ${folder}` : `${saved.length} uploaded to ${folder}`)
          return { toast: text, refresh: true }
        },
      },
    })
  })
}

/** 供测试和排查用：当前解析出的工作区根目录。 */
export const workspaceRootPath = ROOT
