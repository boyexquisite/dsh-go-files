// 用官方插件工具包里的测试宿主跑一遍「面板注册 + 点按」。
// 找不到工具包时整组跳过（这个测试只在装了 dsh-go-plugin 技能的机器上有意义）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dateFolder, rootOf, UPLOAD_DIR } from '../lib/workspace.js'

const HOME = process.env.HOME ?? ''
const KITS = [
  process.env.DSH_PLUGIN_KIT,
  join(process.env.DSH_HOME ?? (HOME === '' ? '' : join(HOME, '.dsh')), 'skills', 'dsh-go-plugin', 'kit'),
  '/root/.dsh/skills/dsh-go-plugin/kit',
].filter((kit) => typeof kit === 'string' && kit !== '')

let kit
for (const dir of KITS) {
  if (!existsSync(join(dir, 'lib', 'testing.js'))) continue
  try {
    kit = { dir, ...(await import(pathToFileURL(join(dir, 'lib', 'testing.js')).href)) }
    break
  } catch {
    /* 试下一个 */
  }
}

const SKIP = kit === undefined ? 'dsh-go-plugin 工具包不在本机' : false

// 1×1 透明 PNG：不需要 ffmpeg 也能验证图片预览链路。
const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const here = new URL('..', import.meta.url).pathname

function makeHost(options = {}) {
  const host = kit.createTestHost({ dir: here, caps: { features: ['files'] }, ...options })
  return host
}

function tempRoot() {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'dsh-plugin-')))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'note.md'), '# hi')
  writeFileSync(join(root, 'a.txt'), 'hello')
  return root
}

function walk(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, out)
    return out
  }
  if (typeof node.type === 'string') out.push(node)
  for (const value of Object.values(node)) walk(value, out)
  return out
}

test('manifest parses and the panel is declared in the sidebar', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const row = host.contributions({ features: ['files'] })
    assert.equal(row.state, 'ok', JSON.stringify(row.issues))
    const panel = row.contributes.panels.find((p) => p.id === 'files')
    assert.ok(panel)
    assert.deepEqual(panel.placement, ['session.tab', 'features', 'chat.panel'])
    assert.deepEqual([...row.capabilities], ['files'])
    assert.equal(host.registrations().panels.includes('files'), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('panel browses into a folder and back', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const caps = { features: ['files'] }
    const scope = { sessionId: 's1' }

    const first = await host.view('files', scope, caps)
    assert.ok(walk(first.view).some((n) => n.type === 'list'))

    const into = await host.invoke('files', { surface: 'panel', action: 'enter', scope, value: { path: 'docs' } })
    assert.deepEqual(into.effects, [{ type: 'refresh', id: 'files' }])
    const inside = await host.view('files', scope, caps)
    assert.ok(walk(inside.view).some((n) => n.type === 'text' && n.text === 'docs'))

    await host.invoke('files', { surface: 'panel', action: 'up', scope })
    const back = await host.view('files', scope, caps)
    assert.ok(walk(back.view).some((n) => n.type === 'text' && n.text === '/'))
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('opening a file previews it and back returns to the folder', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const caps = { features: ['files'] }
    const scope = { sessionId: 's2' }

    await host.invoke('files', { surface: 'panel', action: 'open', scope, value: { path: 'docs/note.md' } })
    const preview = await host.view('files', scope, caps)
    const code = walk(preview.view).find((n) => n.type === 'codeBlock')
    assert.equal(code.code, '# hi')

    await host.invoke('files', { surface: 'panel', action: 'back', scope })
    const browsing = await host.view('files', scope, caps)
    assert.ok(walk(browsing.view).some((n) => n.type === 'list'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upload asks the app for a file picker only on a real tap', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const scope = { sessionId: 's3' }

    const tapped = await host.invoke('files', {
      surface: 'panel', action: 'upload', scope, userGesture: true,
    })
    assert.deepEqual(tapped.effects, [{ type: 'pickFile', action: 'receive', maxFiles: 4 }])

    const background = await host.invoke('files', {
      surface: 'panel', action: 'upload', scope, userGesture: false,
    })
    assert.equal(background.effects.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a cancelled selection only says so', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const result = await host.invoke('files', {
      surface: 'panel',
      action: 'receive',
      scope: { sessionId: 's4' },
      value: { status: 'cancelled', files: [] },
    })
    assert.deepEqual(result.effects, [{ type: 'toast', text: '已取消上传' }])
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('paths outside the workspace are rejected by the panel', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const result = await host.invoke('files', {
      surface: 'panel', action: 'enter', scope: { sessionId: 's5' }, value: { path: '../etc' },
    })
    assert.equal(result.effects[0].type, 'toast')
    assert.ok(result.effects[0].text.includes('工作区'))
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('opening an image prepares an asset the app can draw', { skip: SKIP }, async () => {
  const root = tempRoot()
  const cache = join(root, '.cache')
  try {
    writeFileSync(join(root, 'pic.png'), Buffer.from(PNG_1PX, 'base64'))
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root, cacheDir: cache })
    const scope = { sessionId: 'img1' }
    const browse = await host.view('files', scope, { features: ['files'] })
    const browseNodes = walk(browse.view)
    assert.ok(browseNodes.some((n) => n.type === 'gallery'), 'thumbnail gallery at folder level')
    const browseList = browseNodes.find((n) => n.type === 'list')
    assert.ok(browseList)
    assert.ok(!browseList.items.some((i) => i.title === 'pic.png'))

    const opened = await host.invoke('files', { surface: 'panel', action: 'open', scope, value: { path: 'pic.png' } })
    assert.deepEqual(opened.effects, [{ type: 'refresh', id: 'files' }])

    const view = await host.view('files', scope, { features: ['files'] })
    const nodes = walk(view.view)
    const gallery = nodes.find((n) => n.type === 'gallery')
    assert.ok(gallery, 'gallery rendered')
    assert.equal(gallery.items[0].src.startsWith('asset:preview/'), true)
    assert.match(gallery.items[0].src, /^asset:preview\/[0-9a-f]+\.png$/)
    const cached = join(cache, gallery.items[0].src.slice('asset:preview/'.length))
    assert.ok(existsSync(cached))
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('upload callback saves the picked files into artifacts/uploads/<date>/', { skip: SKIP }, async () => {
  const root = tempRoot()
  try {
    const host = makeHost()
    // 测试宿主没有真实上传路由，这里替身给出 selected 文件的字节。
    host.dshGo.readPickedFile = (handle) => {
      if (handle === 'ok') return Buffer.from('hello from the phone')
      throw new Error('handle expired')
    }
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root })
    const scope = { sessionId: 'up1' }
    const result = await host.invoke('files', {
      surface: 'panel',
      action: 'receive',
      scope,
      value: {
        status: 'selected',
        files: [
          { handle: 'ok', name: '/sdcard/DCIM/note.txt' },
          { handle: 'gone', name: 'bad.txt' },
        ],
      },
    })
    const toast = result.effects.find((e) => e.type === 'toast')
    assert.match(toast.text, /1 个，1 个失败/)
    assert.ok(result.effects.some((e) => e.type === 'refresh'))

    const folder = `${UPLOAD_DIR}/${dateFolder()}`
    const nodes = walk((await host.view('files', scope, { features: ['files'] })).view)
    const list = nodes.find((n) => n.type === 'list')
    assert.deepEqual(list.items.map((i) => i.title), ['note.txt'])
    // 面板自动进了刚上传的目录；路径是 artifacts/uploads/<date>，不再是根 uploads/
    assert.ok(nodes.some((n) => n.type === 'text' && n.text === folder))

    const saved = join(root, 'artifacts', 'uploads', dateFolder(), 'note.txt')
    assert.equal(readFileSync(saved, 'utf8'), 'hello from the phone')
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('files can be moved into another folder from the panel', { skip: SKIP }, async () => {
  const root = tempRoot()
  const cache = join(root, '.cache')
  try {
    mkdirSync(join(root, 'archive'), { recursive: true })
    writeFileSync(join(root, 'docs', 'note.md'), '# hi')
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root, cacheDir: cache })
    const scope = { sessionId: 'mv1' }

    await host.invoke('files', { surface: 'panel', action: 'open', scope, value: { path: 'docs/note.md' } })
    const start = await host.invoke('files', { surface: 'panel', action: 'move', scope })
    assert.deepEqual(start.effects, [{ type: 'refresh', id: 'files' }])
    const picking = await host.view('files', scope, { features: ['files'] })
    const pickNodes = walk(picking.view)
    const pickList = pickNodes.find((n) => n.type === 'list')
    assert.ok(pickList.items.some((i) => i.title === 'archive'))

    await host.invoke('files', { surface: 'panel', action: 'enterMove', scope, value: { path: 'archive' } })
    const moved = await host.invoke('files', { surface: 'panel', action: 'moveHere', scope })
    assert.match(moved.effects[0].text, /已移动到 archive/)
    assert.ok(existsSync(join(root, 'archive', 'note.md')))
    assert.ok(!existsSync(join(root, 'docs', 'note.md')))

    const after = await host.view('files', scope, { features: ['files'] })
    const titles = walk(after.view).find((n) => n.type === 'list')?.items.map((i) => i.title)
    assert.ok(titles?.includes('note.md'))
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('deleting a file needs the confirmation and then removes it', { skip: SKIP }, async () => {
  const root = tempRoot()
  const cache = join(root, '.cache')
  try {
    writeFileSync(join(root, 'docs', 'note.md'), '# hi')
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root, cacheDir: cache })
    const scope = { sessionId: 'del1' }

    await host.invoke('files', { surface: 'panel', action: 'open', scope, value: { path: 'docs/note.md' } })
    const cancelled = await host.invoke('files', { surface: 'panel', action: 'deleteFile', scope, value: { confirmed: false } })
    assert.match(cancelled.effects[0].text, /取消/)
    assert.ok(existsSync(join(root, 'docs', 'note.md')))

    const deleted = await host.invoke('files', { surface: 'panel', action: 'deleteFile', scope, value: { confirmed: true } })
    assert.match(deleted.effects[0].text, /已删除/)
    assert.ok(!existsSync(join(root, 'docs', 'note.md')))
    const back = await host.view('files', scope, { features: ['files'] })
    const backNodes = walk(back.view)
    assert.ok(backNodes.some((n) => n.type === 'list'), 'back to the folder listing')
    assert.ok(!backNodes.some((n) => n.type === 'codeBlock'), 'file preview closed')
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})

test('an empty folder can be deleted from its page', { skip: SKIP }, async () => {
  const root = tempRoot()
  const cache = join(root, '.cache')
  try {
    mkdirSync(join(root, 'empty'), { recursive: true })
    const host = makeHost()
    const plugin = await import('../lib/index.js')
    plugin.apply(host.ctx, { root, cacheDir: cache })
    const scope = { sessionId: 'del2' }

    await host.invoke('files', { surface: 'panel', action: 'enter', scope, value: { path: 'empty' } })
    const page = await host.view('files', scope, { features: ['files'] })
    assert.ok(walk(page.view).some((n) => n.type === 'confirm' && n.id === 'deleteDir'))

    const deleted = await host.invoke('files', { surface: 'panel', action: 'deleteDir', scope, value: { confirmed: true } })
    assert.ok(deleted.effects.some((e) => e.type === 'refresh'))
    assert.ok(!existsSync(join(root, 'empty')))
    const rootView = await host.view('files', scope, { features: ['files'] })
    assert.ok(!walk(rootView.view).find((n) => n.type === 'list')?.items.some((i) => i.title === 'empty'))
    assert.deepEqual(host.violations, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(cache, { recursive: true, force: true })
  }
})
