import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import {
  UPLOAD_DIR,
  dateFolder,
  deleteEmptyFolder,
  deleteFile,
  moveFile,
  noPermissionFs,
  relativeOf,
  resolveInside,
  rootOf,
  safeName,
  savePicked,
} from '../lib/workspace.js'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const V2 = { locale: 'zh-CN', components: ['emptyState', 'codeBlock', 'gallery'], features: ['files'] }

function setup(options = {}) {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-safety-')))
  let panel
  apply({ inject: (_, fn) => fn({ dshGo: { panel: (_, def) => { panel = def } } }) }, { root, ...options })
  return { root, panel }
}
function confirmId(node) {
  if (!node || typeof node !== 'object') return undefined
  if (node.type === 'confirm') return node.id
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) { const id = confirmId(child); if (id) return id }
    } else { const id = confirmId(value); if (id) return id }
  }
}
test('stale file and folder confirmations never act on another panel location', () => {
  const { root, panel } = setup()
  const scope = { sessionId: 'shared' }
  const event = (path) => ({ value: { path } })
  try {
    writeFileSync(join(root, 'a'), 'a')
    writeFileSync(join(root, 'b'), 'b')
    mkdirSync(join(root, 'd1')); mkdirSync(join(root, 'd2'))
    panel.actions.open(scope, event('a'))
    const oldFile = confirmId(panel.view(scope, {}))
    panel.actions.open(scope, event('b'))
    assert.match(panel.actions[oldFile](scope, { value: { confirmed: true } }).toast, /改变/)
    assert.ok(existsSync(join(root, 'a')) && existsSync(join(root, 'b')))
    assert.equal(panel.actions[oldFile], undefined)
    assert.equal(panel.actions.deleteFile, undefined)
    panel.actions.move(scope, {})
    const moveView = panel.view(scope, {})
    const moveId = moveView.children.flatMap((n) => n.items ?? []).find((item) => item.label === '移动到这里').action
    panel.actions.enterMove(scope, event('d1'))
    assert.match(panel.actions[moveId](scope, {}).toast, /改变/)
    assert.ok(existsSync(join(root, 'b')))
    assert.equal(panel.actions.moveHere, undefined)
    panel.actions.enter(scope, event('d1'))
    const oldDir = confirmId(panel.view(scope, {}))
    panel.actions.enter(scope, event('d2'))
    panel.actions[oldDir](scope, { value: { confirmed: true } })
    assert.ok(existsSync(join(root, 'd1')) && existsSync(join(root, 'd2')))
    const id = confirmId(panel.view(scope, {}))
    panel.actions[id]({ sessionId: 'different' }, { value: { confirmed: true } })
    assert.ok(existsSync(join(root, 'd2')))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('missing paths through outside links and upload directory swaps are rejected', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-root-')))
  const outside = rootOf(mkdtempSync(join(tmpdir(), 'files-outside-')))
  try {
    symlinkSync(outside, join(root, 'escape'))
    assert.equal(resolveInside(root, 'escape/missing'), undefined)
    assert.equal(safeName('a\u0000b\u0001c'), 'abc')
    const result = savePicked([{ handle: 'h', name: 'x' }], () => {
      renameSync(join(root, 'uploads'), join(root, 'old-uploads'))
      symlinkSync(outside, join(root, 'uploads'))
      return Buffer.from('test')
    }, { root, folder: 'uploads' })
    assert.equal(result.saved.length, 0)
    assert.equal(existsSync(join(outside, 'x')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('atomic move refuses an existing target and never runs PATH helpers', { skip: process.platform !== 'linux' }, () => {
  // 2026-11-27 全检 P1：旧实现用 spawnSync('python3') 走 PATH，这个用例当时用一个假
  // python3 证明「目标被抢占」时也能执行任意代码。现在实现改成 Node 原生 link+unlink：
  // 既验证不覆盖语义，也验证 PATH 里的恶意 python3 根本不会被调用。
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-race-')))
  const oldPath = process.env.PATH
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dst')); mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'src', 'a'), 'source')
    writeFileSync(join(root, 'bin', 'python3'), '#!/bin/sh\nprintf pwned > "$4"\n')
    chmodSync(join(root, 'bin', 'python3'), 0o755)
    writeFileSync(join(root, 'dst', 'a'), 'rival')
    process.env.PATH = join(root, 'bin')
    assert.equal(moveFile(root, 'src/a', 'dst').error, 'exists')
    assert.equal(readFileSync(join(root, 'src', 'a'), 'utf8'), 'source')
    assert.equal(readFileSync(join(root, 'dst', 'a'), 'utf8'), 'rival')
    // 正常移动不依赖任何外部解释器：清空 PATH 也能成功，且源消失
    unlinkSync(join(root, 'dst', 'a'))
    process.env.PATH = join(root, 'missing')
    assert.equal(moveFile(root, 'src/a', 'dst').name, 'a')
    assert.equal(existsSync(join(root, 'src', 'a')), false)
    assert.equal(readFileSync(join(root, 'dst', 'a'), 'utf8'), 'source')
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 修复 P0-1：移动不是原子操作，但不能删掉别人的新数据 ─────────────
test('move never deletes a new file that took the source path after link', { skip: process.platform !== 'linux' }, () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-move-race-')))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dst'))
    writeFileSync(join(root, 'src', 'a'), 'old')
    // 屏障：link 刚成功、还没删源时，另一个进程按「改名保存 + 原路径建新文件」换了源。
    const result = moveFile(root, 'src/a', 'dst', {
      afterLink: () => {
        renameSync(join(root, 'src', 'a'), join(root, 'src', 'a.bak'))
        writeFileSync(join(root, 'src', 'a'), 'new')
      },
    })
    assert.equal(result.error, 'source-changed')
    assert.equal(readFileSync(join(root, 'src', 'a'), 'utf8'), 'new', '新文件不能被删')
    assert.equal(readFileSync(join(root, 'src', 'a.bak'), 'utf8'), 'old', '旧内容还在')
    assert.equal(existsSync(join(root, 'dst', 'a')), false, '目标要回滚掉')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('move rollback never deletes a target that was replaced meanwhile', { skip: process.platform !== 'linux' }, () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-move-rollback-')))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dst'))
    writeFileSync(join(root, 'src', 'a'), 'old')
    const result = moveFile(root, 'src/a', 'dst', {
      afterLink: () => {
        // 目标被换成别的 inode，源也被换掉 —— 两个回滚条件同时出现。
        renameSync(join(root, 'dst', 'a'), join(root, 'dst', 'kept'))
        writeFileSync(join(root, 'dst', 'a'), 'rival')
        renameSync(join(root, 'src', 'a'), join(root, 'src', 'a.bak'))
        writeFileSync(join(root, 'src', 'a'), 'new')
      },
    })
    assert.equal(result.error, 'source-changed')
    assert.equal(readFileSync(join(root, 'dst', 'a'), 'utf8'), 'rival', '只回滚自己 link 的那个 inode')
    assert.equal(readFileSync(join(root, 'dst', 'kept'), 'utf8'), 'old')
    assert.equal(readFileSync(join(root, 'src', 'a'), 'utf8'), 'new')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 修复 P0-2：校验过的父目录被换走时 fail closed ────────────────────
test('delete refuses when the parent is swapped to an outside symlink after validation', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-parent-swap-')))
  const outside = rootOf(mkdtempSync(join(tmpdir(), 'files-parent-out-')))
  try {
    mkdirSync(join(root, 'sub'))
    writeFileSync(join(root, 'sub', 'f'), 'inside')
    // 外面那条是**同 inode 的硬链接**：末端身份复核会认为「还是这个文件」，
    // 于是这条用例只有父目录守卫能拦住（复审要求：单独证明父目录守卫在起作用）。
    linkSync(join(root, 'sub', 'f'), join(outside, 'f'))
    const result = deleteFile(root, 'sub/f', {
      afterCheck: () => {
        renameSync(join(root, 'sub'), join(root, 'sub-real'))
        symlinkSync(outside, join(root, 'sub'))
      },
    })
    assert.equal(result.error, 'changed')
    assert.ok(existsSync(join(outside, 'f')), '工作区外那条硬链接不能被删')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('delete refuses when the parent is replaced by another directory at the same path', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-parent-inode-')))
  try {
    mkdirSync(join(root, 'sub'))
    mkdirSync(join(root, 'shadow'))
    writeFileSync(join(root, 'sub', 'f'), 'inside')
    // shadow/f 是指向同一个 inode 的硬链接：换掉父目录之后末端仍然「没变」，
    // 只有「父目录还是不是那个 inode」这条能发现。
    linkSync(join(root, 'sub', 'f'), join(root, 'shadow', 'f'))
    const result = deleteFile(root, 'sub/f', {
      afterCheck: () => {
        renameSync(join(root, 'sub'), join(root, 'sub-old'))
        renameSync(join(root, 'shadow'), join(root, 'sub'))
      },
    })
    assert.equal(result.error, 'changed')
    assert.ok(existsSync(join(root, 'sub', 'f')), '换上新父目录后这个文件不该被删')
    assert.ok(existsSync(join(root, 'sub-old', 'f')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleting an empty folder refuses a swapped parent too', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-rmdir-swap-')))
  const outside = rootOf(mkdtempSync(join(tmpdir(), 'files-rmdir-out-')))
  try {
    mkdirSync(join(root, 'p', 'empty'), { recursive: true })
    mkdirSync(join(outside, 'empty'))
    const result = deleteEmptyFolder(root, 'p/empty', {
      afterCheck: () => {
        renameSync(join(root, 'p'), join(root, 'p-old'))
        symlinkSync(outside, join(root, 'p'))
      },
    })
    assert.equal(result.error, 'changed')
    assert.ok(existsSync(join(outside, 'empty')), '工作区外的空目录不能被删')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

// ── 2026-11-28 修复 P1-2：旧删除确认不能删掉重新打开的同名新文件 ────────────────
test('a confirmation from before reopening the same path cannot delete the new file', () => {
  const { root, panel } = setup()
  const scope = { sessionId: 'reopen' }
  const event = (path) => ({ value: { path } })
  try {
    writeFileSync(join(root, 'a'), 'v1')
    panel.actions.open(scope, event('a'))
    const oldId = confirmId(panel.view(scope, {}))
    panel.actions.back(scope, {})
    unlinkSync(join(root, 'a'))
    writeFileSync(join(root, 'a'), 'v2')
    panel.actions.open(scope, event('a'))
    assert.match(panel.actions[oldId](scope, { value: { confirmed: true } }).toast, /改变/)
    assert.equal(readFileSync(join(root, 'a'), 'utf8'), 'v2')

    // 原地换 inode（不离开页面）：确认时记的 inode 对不上，也不删。
    writeFileSync(join(root, 'b'), 'v1')
    panel.actions.open(scope, event('b'))
    const id = confirmId(panel.view(scope, {}))
    unlinkSync(join(root, 'b'))
    writeFileSync(join(root, 'b'), 'v2')
    assert.match(panel.actions[id](scope, { value: { confirmed: true } }).toast, /变了/)
    assert.equal(readFileSync(join(root, 'b'), 'utf8'), 'v2')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 修复 P1-1 / P2-10：上传发布不留半成品，个数上限自己再核一次 ──────
test('uploads publish atomically and honour the file-count cap', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-upload-atomic-')))
  try {
    const files = Array.from({ length: 5 }, (_, i) => ({ handle: `h${i}`, name: `f${i}.txt` }))
    const result = savePicked(files, (handle) => Buffer.from(`data-${handle}`), { root })
    assert.equal(result.saved.length, 4)
    assert.deepEqual(result.failed.map((file) => file.name), ['f4.txt'])
    const dir = join(root, UPLOAD_DIR, dateFolder())
    const names = readdirSync(dir)
    assert.deepEqual(names.filter((name) => name.startsWith('.upload-')), [], '不留临时文件')
    assert.equal(readFileSync(join(dir, 'f0.txt'), 'utf8'), 'data-h0')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 修复 P2-7：工作区配成 `/` 时子路径不能全被拒 ──────────────────────
test('a workspace root of / still resolves its children', () => {
  assert.equal(resolveInside('/', 'tmp'), '/tmp')
  assert.equal(relativeOf('/', '/tmp'), 'tmp')
  assert.equal(resolveInside('/', ''), '/')
})

// ── 2026-11-28 修复 P1-4：算好的缩略图要留在会话状态里，别每次取视图都重转 ────────
test('folder thumbnails are cached in the session state between views', () => {
  const cache = join(tmpdir(), `files-thumbs-${process.pid}-${Date.now()}`)
  const { root, panel } = setup({ cacheDir: cache })
  const scope = { sessionId: 'thumbs' }
  try {
    const image = join(root, 'p.png')
    writeFileSync(image, Buffer.from(PNG_1PX, 'base64'))
    const first = panel.view(scope, V2)
    const firstThumbs = JSON.stringify(first).match(/asset:preview\/[0-9a-f]+\.png/g) ?? []
    assert.equal(firstThumbs.length, 1, 'one thumbnail rendered')
    // 换个 mtime：缓存键（size+mtime）会变。真去重转就会得到另一个文件名。
    utimesSync(image, new Date(), new Date(Date.now() + 5000))
    const second = panel.view(scope, V2)
    const secondThumbs = JSON.stringify(second).match(/asset:preview\/[0-9a-f]+\.png/g) ?? []
    assert.deepEqual(secondThumbs, firstThumbs, 'second view must reuse the cached thumbnail')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

// ── 2026-11-28 第二轮：P0-2 收口 —— 祖先目录对 other 可写就直接拒绝 ──────────────
test('destructive operations refuse ancestors that other users can write', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-unsafe-parent-')))
  try {
    mkdirSync(join(root, 'open'))
    mkdirSync(join(root, 'dst-open'))
    mkdirSync(join(root, 'open', 'empty'))
    writeFileSync(join(root, 'open', 'f'), 'x')
    chmodSync(join(root, 'open'), 0o777)
    chmodSync(join(root, 'dst-open'), 0o777)
    const moved = join(root, 'src.txt')
    writeFileSync(moved, 'y')
    assert.equal(deleteFile(root, 'open/f').error, 'unsafe-parent')
    assert.equal(deleteEmptyFolder(root, 'open/empty').error, 'unsafe-parent')
    assert.equal(moveFile(root, 'src.txt', 'dst-open').error, 'unsafe-parent')
    const upload = savePicked([{ handle: 'h', name: 'a.txt' }], () => Buffer.from('x'), { root, folder: 'open/day' })
    assert.equal(upload.error, 'unsafe-parent')
    assert.equal(upload.saved.length, 0)
    assert.ok(existsSync(join(root, 'open', 'f')), '没有动过文件')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('sticky ancestor directories are still usable', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-sticky-')))
  try {
    mkdirSync(join(root, 'shared'))
    chmodSync(join(root, 'shared'), 0o1777)
    writeFileSync(join(root, 'shared', 'mine.txt'), 'x')
    // sticky：别人删不掉/换不掉我的目录项，所以放行。
    assert.equal(deleteFile(root, 'shared/mine.txt').name, 'mine.txt')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 第二轮：目标目录 identity 守卫（复审要求补的覆盖） ────────────────
test('move refuses when the target folder was swapped after validation', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-target-swap-')))
  try {
    mkdirSync(join(root, 'src'))
    mkdirSync(join(root, 'dst'))
    writeFileSync(join(root, 'src', 'f'), 'payload')
    const result = moveFile(root, 'src/f', 'dst', {
      afterResolve: () => {
        // 同名的另一个目录顶上来：祖先链、源文件都没变，只有目标目录的 dev:ino 变了。
        renameSync(join(root, 'dst'), join(root, 'dst-old'))
        mkdirSync(join(root, 'dst'))
      },
    })
    assert.equal(result.error, 'changed')
    assert.ok(!existsSync(join(root, 'dst', 'f')), '不能写进被换掉的目标目录')
    assert.ok(!existsSync(join(root, 'dst-old', 'f')))
    assert.equal(readFileSync(join(root, 'src', 'f'), 'utf8'), 'payload')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 第三轮 F1：vfat / SD 卡这类「所有目录都报 0777」的存储不能整体变只读 ──
test('0777 ancestors on a permission-less filesystem are allowed', () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-vfat-')))
  const infos = []
  const original = console.info
  console.info = (...args) => { infos.push(args.join(' ')) }
  try {
    mkdirSync(join(root, 'card'))
    writeFileSync(join(root, 'card', 'f'), 'x')
    chmodSync(join(root, 'card'), 0o777)
    // 本机 /tmp 是 tmpfs（有权限语义）：0777 照旧拒绝，且不该打放行日志
    assert.equal(deleteFile(root, 'card/f').error, 'unsafe-parent')
    assert.deepEqual(infos, [], '拒绝时不该打「放行」日志')
    // 认成 vfat（0x4d44）：放行并留一条 info
    assert.equal(noPermissionFs(0x4d44), true)
    assert.equal(noPermissionFs(0x2011bab0), true)
    assert.equal(noPermissionFs(0xef53), false, 'ext4 有权限语义，不能放行')
    assert.equal(deleteFile(root, 'card/f', { fsType: 0x4d44 }).name, 'f')
    assert.ok(infos.some((line) => line.includes('放行对 other 可写的祖先目录')), '要留一条 info')
    // owner 自己的逃生口
    writeFileSync(join(root, 'card', 'g'), 'y')
    process.env.DSH_FILES_ALLOW_OPEN_ANCESTORS = '1'
    assert.equal(deleteFile(root, 'card/g').name, 'g')
  } finally {
    delete process.env.DSH_FILES_ALLOW_OPEN_ANCESTORS
    console.info = original
    rmSync(root, { recursive: true, force: true })
  }
})

// ── 2026-11-28 第三轮 F2：目录身份要跟着「上一级 / 刷新」走，别假报「文件已经变了」 ──
test('deleting an empty folder after navigating back does not report a false change', () => {
  const { root, panel } = setup()
  const scope = { sessionId: 'dirid' }
  const event = (path) => ({ value: { path } })
  try {
    mkdirSync(join(root, 'outer', 'inner'), { recursive: true })
    panel.actions.enter(scope, event('outer'))
    panel.actions.enter(scope, event('outer/inner'))
    panel.actions.up(scope, {})
    // 外部把 inner 删掉：outer 变成空目录，正是「删空文件夹」的入口
    rmSync(join(root, 'outer', 'inner'), { recursive: true })
    const id = confirmId(panel.view(scope, {}))
    assert.match(panel.actions[id](scope, { value: { confirmed: true } }).toast, /已删除空文件夹/)
    assert.ok(!existsSync(join(root, 'outer')))

    // 刷新也要重取目录身份：同名新目录（换了 inode）刷新后能删
    mkdirSync(join(root, 'fresh'))
    panel.actions.enter(scope, event('fresh'))
    renameSync(join(root, 'fresh'), join(root, 'fresh-old'))
    mkdirSync(join(root, 'fresh'))
    panel.actions.refresh(scope, {})
    const refreshed = confirmId(panel.view(scope, {}))
    assert.match(panel.actions[refreshed](scope, { value: { confirmed: true } }).toast, /已删除空文件夹/)
    assert.ok(!existsSync(join(root, 'fresh')), '刷新后应删掉当前这个同名新目录')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
