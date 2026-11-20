import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rootOf } from '../lib/workspace.js'
import { browseView, fileView, panelView } from '../lib/view.js'

const ALL = [
  'stack', 'row', 'text', 'list', 'actions', 'keyValue', 'callout',
  'codeBlock', 'emptyState', 'divider', 'metric', 'chart',
]

function caps(overrides = {}) {
  return {
    protocol: 1,
    app: '99.0.0',
    locale: 'zh-CN',
    components: ALL,
    features: ['files'],
    ...overrides,
  }
}

function tempRoot() {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'dsh-view-')))
  mkdirSync(join(root, 'docs'), { recursive: true })
  writeFileSync(join(root, 'docs', 'note.md'), '# hi')
  writeFileSync(join(root, 'a.txt'), 'hello world')
  writeFileSync(join(root, 'pic.png'), Buffer.from([0]))
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

test('browse view lists folders then files with actions', () => {
  const root = tempRoot()
  try {
    const view = browseView({ dir: '' }, root, caps())
    assert.equal(view.v, 2)
    const nodes = walk(view)
    const list = nodes.find((n) => n.type === 'list')
    assert.ok(list, 'has a list')
    assert.deepEqual(list.items.map((i) => i.title), ['docs', 'a.txt', 'pic.png'])
    assert.equal(list.items[0].action.id, 'enter')
    assert.equal(list.items[1].action.id, 'open')
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.action), ['up', 'refresh', 'upload'])
    assert.equal(actions.items.at(-1).icon, 'downloads')
    assert.doesNotThrow(() => JSON.stringify(view))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('browse view hides upload and warns when the app cannot pick files', () => {
  const root = tempRoot()
  try {
    const view = browseView({ dir: '' }, root, caps({ features: [] }))
    const nodes = walk(view)
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.action), ['up', 'refresh'])
    const callout = nodes.find((n) => n.type === 'callout')
    assert.ok(callout.text.includes('不支持'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('old app without v2 components gets a v1 view', () => {
  const root = tempRoot()
  try {
    const view = browseView({ dir: '' }, root, caps({ components: undefined }))
    assert.equal(view.v, undefined)
    const types = walk(view).map((n) => n.type)
    assert.ok(!types.includes('emptyState'))
    assert.ok(types.includes('list'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('empty folder uses emptyState in v2 and plain text in v1', () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'empty'), { recursive: true })
    const v2 = walk(browseView({ dir: 'empty' }, root, caps()))
    assert.ok(v2.some((n) => n.type === 'emptyState'))
    const v1 = walk(browseView({ dir: 'empty' }, root, caps({ components: undefined })))
    assert.ok(!v1.some((n) => n.type === 'emptyState'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('missing folder offers a way back to the root', () => {
  const root = tempRoot()
  try {
    const nodes = walk(browseView({ dir: 'gone/deeper' }, root, caps()))
    const callout = nodes.find((n) => n.type === 'callout')
    assert.ok(callout)
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.action), ['root'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file view shows a code block, size and copy actions', () => {
  const root = tempRoot()
  try {
    const view = fileView({ dir: '', file: 'docs/note.md' }, root, caps())
    const nodes = walk(view)
    const code = nodes.find((n) => n.type === 'codeBlock')
    assert.equal(code.code, '# hi')
    assert.equal(code.language, 'markdown')
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.action), ['back', 'copyPath', 'copyText'])
    const kv = nodes.find((n) => n.type === 'keyValue')
    assert.equal(kv.items[0][0], '大小')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file view explains binary files without a code block', () => {
  const root = tempRoot()
  try {
    const nodes = walk(fileView({ dir: '', file: 'pic.png' }, root, caps()))
    assert.ok(nodes.some((n) => n.type === 'callout'))
    assert.ok(!nodes.some((n) => n.type === 'codeBlock'))
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.action), ['back', 'copyPath'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('long previews stay under the panel byte limit', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(7000))
    const view = fileView({ dir: '', file: 'big.txt' }, root, caps())
    assert.ok(Buffer.byteLength(JSON.stringify(view)) < 32768)
    assert.ok(walk(view).some((n) => n.type === 'text' && String(n.text).includes('6000')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('panelView picks preview mode when a file is open', () => {
  const root = tempRoot()
  try {
    assert.ok(walk(panelView({ dir: '', file: 'a.txt' }, root, caps())).some((n) => n.type === 'codeBlock'))
    assert.ok(walk(panelView({ dir: '' }, root, caps())).some((n) => n.type === 'list'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('English locale switches the labels', () => {
  const root = tempRoot()
  try {
    const view = browseView({ dir: '' }, root, caps({ locale: 'en-US' }))
    const nodes = walk(view)
    const actions = nodes.find((n) => n.type === 'actions')
    assert.deepEqual(actions.items.map((i) => i.label), ['Up', 'Refresh', 'Upload'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
