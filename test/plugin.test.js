// 用官方插件工具包里的测试宿主跑一遍「面板注册 + 点按」。
// 找不到工具包时整组跳过（这个测试只在装了 dsh-go-plugin 技能的机器上有意义）。
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootOf } from '../lib/workspace.js'

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
