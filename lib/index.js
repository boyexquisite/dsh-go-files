// dsh-go-files：dsh-go 手机里的「工作区」原生面板。
//
// 侧栏「插件」页签（以及聊天页插件弹层、全部功能）里一页工作区：
// 逛目录、看文本预览、把手机里的文件传进工作区 artifacts/uploads/<日期>/。
// 所有文件操作都跑在主机引擎里，路径被限制在工作区根目录内。
import { readFileSync, statSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { cacheDirOf, mediaKind, prepareImageGallery, prepareMedia } from './media.js'
import { displayName, panelView } from './view.js'
import {
  deleteEmptyFolder as deleteFolderAt,
  deleteFile as deleteFileAt,
  fileIdentity,
  folderIdentity,
  moveFile as moveFileAt,
  previewFile,
  relativeOf,
  resolveInside,
  rootOf,
  savePicked,
  workspaceRoot,
} from './workspace.js'

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

export const name = PKG.name

/** 工作区根目录：DSH 注册表里的工作区，取不到再用引擎 cwd。 */
const ROOT = rootOf(workspaceRoot())

/** 预览缓存放在插件自己的 assets/preview/ 下，App 才能用 asset: 引用。 */
const DEFAULT_CACHE = cacheDirOf(fileURLToPath(new URL('..', import.meta.url)))

const isZh = (locale) => !/^en/i.test(String(locale ?? ''))

const toast = (event, zh, en) => ({ toast: isZh(event?.locale) ? zh : en })

/** 删除 / 移动失败的提示。 */
const failToast = (event, code) => {
  const zh = isZh(event?.locale)
  const messages = {
    denied: [zh ? '没有权限' : 'Not allowed'],
    missing: [zh ? '文件已经不见了' : 'It is gone'],
    link: [zh ? '符号链接不动' : 'Symlinks are left alone'],
    'not-file': [zh ? '不是文件' : 'Not a file'],
    'not-dir': [zh ? '不是文件夹' : 'Not a folder'],
    'not-empty': [zh ? '文件夹里还有东西' : 'Folder is not empty'],
    'no-target': [zh ? '目标目录不见了' : 'Target folder is gone'],
    'same-dir': [zh ? '已经在这个目录里' : 'Already in this folder'],
    exists: [zh ? '目标里已有同名文件' : 'A file with that name exists'],
    unsupported: [zh ? '无法安全移动，未使用覆盖模式' : 'Safe move unavailable'],
    // 2026-11-28 修复 P0-1 / P1-2：校验之后磁盘变了（源被替换、目录被换走），一律拒绝并让人重来。
    changed: [zh ? '文件已经变了，请刷新后再试' : 'The file changed; refresh and try again'],
    'source-changed': [zh ? '源文件已经被改动，没有删除它' : 'The source changed; it was not deleted'],
    // 第二轮：目标目录里可能多出一份副本，必须让用户知道（回滚失败 vs 回滚成功可区分）。
    'source-changed-orphan': [zh ? '源文件被改动；目标目录里多了一份副本，请手动确认' : 'The source changed and a copy was left in the target; check it manually'],
    'left-both': [zh ? '移动没完成：源和目标都还在，请手动确认' : 'Move incomplete: both copies exist; check them manually'],
    'unsafe-parent': [zh ? '上级目录别的用户也能写，不敢动它' : 'An ancestor folder is writable by others'],
  }
  return { toast: (messages[code] ?? [zh ? '操作失败' : 'Failed'])[0] }
}

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
    const MAX_STATES = 200
    const keyOf = (scope) => (typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : 'default')
    const stateOf = (scope) => {
      const key = keyOf(scope)
      let state = states.get(key)
      if (state === undefined) {
        // epoch：视图代次（每次导航 +1）。fileId：打开文件那一刻的 dev:ino。
        // 2026-11-28 修复 P1-2：删除确认绑定这两样，路径字符串相同也不算同一个对象。
        state = { dir: '', file: null, media: undefined, mode: undefined, moveDir: '', thumbs: undefined, epoch: 0, fileId: undefined }
        if (states.size >= MAX_STATES) {
          const oldest = states.keys().next().value
          if (oldest !== undefined) states.delete(oldest)
        }
        states.set(key, state)
      } else {
        states.delete(key)
        states.set(key, state)
      }
      return state
    }

    /**
     * 目录身份：跟着 state.dir 一起更新。
     * 2026-11-28 第三轮 F2：以前只有「进入目录」时取一次，返回上一级 / 移动完成 / 上传落盘 /
     * 刷新之后还是旧目录的 inode —— 删空目录会被自己的 identity 检查假报「文件已经变了」，
     * 而且刷新也救不回来（刷新当时只重取 fileId）。
     */
    const dirIdOf = (dir) => (dir === '' ? undefined : folderIdentity(root, dir))

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
      state.mode = undefined
      state.epoch += 1
      state.thumbs = undefined
      if (kind === 'dir') {
        state.dir = rel
        state.file = null
        state.media = undefined
        state.fileId = undefined
        state.dirId = dirIdOf(rel)
      } else {
        state.file = rel
        state.fileId = fileIdentity(root, rel)
        // 图片 / 视频：先转成 App 能引用的资源（复制或压缩进 assets/preview）。
        const kind = mediaKind(rel)
        try {
          if (kind === undefined) state.media = undefined
          else if (kind === 'image') {
            const { opened, items } = prepareImageGallery(root, rel, cache)
            state.media = { ...opened, gallery: items }
          } else state.media = prepareMedia(root, rel, cache)
        } catch {
          state.media = { error: 'convert-failed' }
        }
      }
      return { refresh: true }
    }

    const deleteConfirmed = (kind, scope, event, expectId) => {
      if (event?.value?.confirmed !== true) return toast(event, '已取消', 'Cancelled')
      const state = stateOf(scope)
      if (kind === 'deleteFile') {
        const name = state.file.split('/').at(-1) ?? ''
        // expect：确认那一刻的 inode。同名同路径但换了 inode 的新文件不会被旧确认删掉。
        const result = deleteFileAt(root, state.file, { expect: expectId })
        if (result.error) return failToast(event, result.error)
        state.file = null
        state.fileId = undefined
        state.media = undefined
        state.thumbs = undefined
        const zh = isZh(event?.locale)
        return { toast: zh ? `已删除 ${displayName(name, 20)}` : `Deleted ${displayName(name, 20)}`, refresh: true }
      }
      const parent = parentOf(state.dir)
      // 空目录也要绑身份：同名新目录（换了 inode）不能被旧确认删掉（第二轮 N5）。
      const result = deleteFolderAt(root, state.dir, { expect: expectId })
      if (result.error) return failToast(event, result.error)
      state.dir = parent
      state.file = null
      state.media = undefined
      state.thumbs = undefined
      const zh = isZh(event?.locale)
      return { toast: zh ? '已删除空文件夹' : 'Empty folder deleted', refresh: true }
    }
    const moveConfirmed = (scope, event) => {
      const state = stateOf(scope)
      const result = moveFileAt(root, state.file, state.moveDir ?? '')
      if (result.error) return { ...failToast(event, result.error), refresh: true }
      state.mode = undefined
      state.dir = result.dir
      state.dirId = dirIdOf(result.dir)
      state.file = null
      state.fileId = undefined
      state.media = undefined
      state.thumbs = undefined
      const zh = isZh(event?.locale)
      const where = result.dir === '' ? (zh ? '工作区根目录' : 'the workspace root') : displayName(result.dir, 60)
      return { toast: zh ? `已移动到 ${where}` : `Moved to ${where}`, refresh: true }
    }
    const confirmationActions = []
    const panel = {
      view(scope, caps) {
        const state = stateOf(scope)
        const snapshot = { ...state }
        const kind = typeof state.file === 'string' ? 'deleteFile' : state.dir !== '' ? 'deleteDir' : undefined
        // 2026-11-28 第二轮 N6：打开时没拿到 inode（非常规文件 / 父目录不可解析）就不生成
        // 删除确认 —— 否则确认会退化成「只绑路径」，方向是 fail-open。
        const confirmable = kind !== 'deleteFile' || typeof state.fileId === 'string'
        if (kind && confirmable && state.mode !== 'move') {
          const path = kind === 'deleteFile' ? state.file : state.dir
          const key = keyOf(scope)
          const id = `d${randomBytes(16).toString('hex')}`
          // 2026-11-28 修复 P1-2：确认绑定「视图代次 + 文件 inode」。
          // 只比路径挡不住「返回后原路径又出现一个同名文件」——路径一样，对象不是同一个。
          const epoch = state.epoch ?? 0
          const fileId = kind === 'deleteFile' ? state.fileId : state.dirId
          snapshot[`${kind}Action`] = id
          panel.actions[id] = (requestScope, event) => {
            if (keyOf(requestScope) !== key) return toast(event, '确认已失效', 'Confirmation expired')
            if (event?.value?.confirmed !== true) return toast(event, '已取消', 'Cancelled')
            delete panel.actions[id]
            const i = confirmationActions.indexOf(id)
            if (i !== -1) confirmationActions.splice(i, 1)
            const current = stateOf(requestScope)
            if ((kind === 'deleteFile' ? current.file : current.dir) !== path ||
                (kind === 'deleteDir' && current.file !== null) || current.mode === 'move' ||
                (current.epoch ?? 0) !== epoch) {
              return toast(event, '位置已改变，请重新确认', 'Location changed; confirm again')
            }
            return deleteConfirmed(kind, requestScope, event, fileId)
          }
          confirmationActions.push(id)
          if (confirmationActions.length > 1000) delete panel.actions[confirmationActions.shift()]
        }
        if (state.mode === 'move' && typeof state.file === 'string') {
          const path = state.file
          const dir = state.moveDir
          const key = keyOf(scope)
          const id = `m${randomBytes(16).toString('hex')}`
          const epoch = state.epoch ?? 0
          snapshot.moveHereAction = id
          panel.actions[id] = (requestScope, event) => {
            if (keyOf(requestScope) !== key) return toast(event, '操作已失效', 'Action expired')
            delete panel.actions[id]
            const i = confirmationActions.indexOf(id)
            if (i !== -1) confirmationActions.splice(i, 1)
            const current = stateOf(requestScope)
            if (current.mode !== 'move' || current.file !== path || current.moveDir !== dir ||
                (current.epoch ?? 0) !== epoch) {
              return toast(event, '位置已改变，请重新选择', 'Location changed; choose again')
            }
            return moveConfirmed(requestScope, event)
          }
          confirmationActions.push(id)
          if (confirmationActions.length > 1000) delete panel.actions[confirmationActions.shift()]
        }
        const view = panelView(snapshot, root, caps, cache)
        // 2026-11-28 修复 P1-4：缩略图是 panelView 写进传进去那个对象的。以前传的是快照，
        // 算好的缩略图直接丢掉，每次取视图都重新转一遍。现在写回真实状态。
        state.thumbs = snapshot.thumbs
        return view
      },
      actions: {
        enter: show,
        open: show,

        up(scope, event) {
          const state = stateOf(scope)
          if (state.dir === '') return toast(event, '已经在工作区根目录', 'Already at the workspace root')
          state.epoch += 1
          state.dir = parentOf(state.dir)
          state.dirId = dirIdOf(state.dir)
          state.file = null
          state.fileId = undefined
          state.media = undefined
          state.thumbs = undefined
          return { refresh: true }
        },

        root(scope) {
          const state = stateOf(scope)
          state.epoch += 1
          state.dir = ''
          state.file = null
          state.fileId = undefined
          state.dirId = undefined
          state.media = undefined
          state.thumbs = undefined
          return { refresh: true }
        },

        back(scope) {
          const state = stateOf(scope)
          // 返回 = 离开这个文件：代次 +1，让旧删除确认作废（P1-2）。
          state.epoch += 1
          state.file = null
          state.fileId = undefined
          state.media = undefined
          return { refresh: true }
        },

        refresh(scope) {
          // 目录内容可能变了，缩略图缓存作废；文件和目录身份都重取（可能已经被替换）。
          const state = stateOf(scope)
          state.epoch += 1
          state.thumbs = undefined
          state.fileId = typeof state.file === 'string' ? fileIdentity(root, state.file) : undefined
          state.dirId = dirIdOf(typeof state.dir === 'string' ? state.dir : '')
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

        /** 进入「移动到…」选目录模式。 */
        move(scope, event) {
          const state = stateOf(scope)
          if (typeof state.file !== 'string') return toast(event, '先打开一个文件', 'Open a file first')
          state.epoch += 1
          state.mode = 'move'
          // 从工作区根目录开始选，方便跨目录移动。
          state.moveDir = ''
          return { refresh: true }
        },

        enterMove(scope, event) {
          const path = typeof event?.value?.path === 'string' ? event.value.path : undefined
          if (path === undefined) return toast(event, '没有拿到路径', 'No path received')
          if (resolveInside(root, path) === undefined) return toast(event, '这个位置不在工作区里', 'That path is outside the workspace')
          const state = stateOf(scope)
          state.epoch += 1
          state.moveDir = path
          return { refresh: true }
        },

        upMove(scope) {
          const state = stateOf(scope)
          state.epoch += 1
          state.moveDir = parentOf(state.moveDir)
          return { refresh: true }
        },

        cancelMove(scope) {
          const state = stateOf(scope)
          state.epoch += 1
          state.mode = undefined
          return { refresh: true }
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
            result = savePicked(value.files, (handle) => ctx.dshGo.readPickedFile(handle), { root, maxFiles: 4 })
          } catch {
            return toast(event, '上传失败：保存不了文件', 'Upload failed: cannot save the file')
          }
          if (result.error === 'mkdir') {
            return toast(event, '上传失败：写不进工作区', 'Upload failed: cannot write to the workspace')
          }
          if (result.error === 'unsafe-parent') {
            return toast(event, '上传失败：上级目录别的用户也能写，不敢落盘', 'Upload failed: an ancestor folder is writable by others')
          }
          const { saved, failed, folder } = result
          const state = stateOf(scope)
          if (saved.length > 0) {
            state.epoch += 1
            state.dir = folder
            state.dirId = dirIdOf(folder)
            state.file = null
            state.fileId = undefined
            state.media = undefined
            state.thumbs = undefined
          }
          if (saved.length === 0) return toast(event, '上传失败，没有文件保存下来', 'Upload failed; nothing was saved')
          const zh = isZh(event?.locale)
          const text = failed.length > 0
            ? (zh ? `上传 ${saved.length} 个，${failed.length} 个失败` : `${saved.length} uploaded, ${failed.length} failed`)
            : (zh ? `已上传 ${saved.length} 个文件到 ${folder}` : `${saved.length} uploaded to ${folder}`)
          return { toast: text, refresh: true }
        },
      },
    }
    ctx.dshGo.panel('files', panel)
  })
}

/** 供测试和排查用：当前解析出的工作区根目录。 */
export const workspaceRootPath = ROOT
