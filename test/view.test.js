import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rootOf } from '../lib/workspace.js'
import { browseView, displayName, fileView, panelView } from '../lib/view.js'

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const ALL = [
  'stack', 'row', 'text', 'list', 'actions', 'keyValue', 'callout',
  'codeBlock', 'emptyState', 'divider', 'metric', 'chart', 'gallery',
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

test('image files become a gallery that opens the full-screen viewer', () => {
  const root = tempRoot()
  try {
    const view = fileView({
      dir: '',
      file: 'pic.png',
      media: {
        kind: 'image', asset: 'asset:preview/abc.jpg', width: 640, height: 480, aspect: 640 / 480, bytes: 12345,
        gallery: [
          { asset: 'asset:preview/abc.jpg', name: 'pic.png', aspect: 640 / 480 },
          { asset: 'asset:preview/def.jpg', name: 'other.png', aspect: 1 },
        ],
      },
    }, root, caps())
    const nodes = walk(view)
    assert.ok(!nodes.some((n) => n.type === 'image'), 'no duplicate inline image')
    const gallery = nodes.find((n) => n.type === 'gallery')
    assert.deepEqual(gallery.items.map((i) => i.src), ['asset:preview/abc.jpg', 'asset:preview/def.jpg'])
    assert.equal(gallery.columns, 2)
    assert.ok(nodes.some((n) => n.type === 'text' && String(n.text).includes('全屏')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('old apps still get a plain inline image', () => {
  const root = tempRoot()
  try {
    const nodes = walk(fileView({
      dir: '',
      file: 'pic.png',
      media: { kind: 'image', asset: 'asset:preview/abc.jpg', width: 640, height: 480, aspect: 640 / 480, bytes: 12345 },
    }, root, caps({ components: undefined })))
    assert.ok(!nodes.some((n) => n.type === 'gallery'))
    assert.equal(nodes.find((n) => n.type === 'image').src, 'asset:preview/abc.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('file headers stay small and only show the folder', () => {
  const root = tempRoot()
  try {
    const longName = 'Screenshot_2026-11-20-17-23-27-65_a26f39edaa70fc7297c941fb49e14188.jpg'
    const nodes = walk(fileView({ dir: 'uploads/2026-11-20', file: `uploads/2026-11-20/${longName}` }, root, caps()))
    const header = nodes.find((n) => n.type === 'text' && String(n.text).startsWith('Screenshot_'))
    assert.ok(header)
    assert.ok(String(header.text).length <= 45)
    assert.ok(String(header.text).includes('…'))
    assert.equal(header.style.size, 'body')
    assert.ok(nodes.some((n) => n.type === 'text' && n.text === 'uploads/2026-11-20'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('displayName shortens the middle of long names', () => {
  assert.equal(displayName('a.txt'), 'a.txt')
  assert.equal(displayName('x'.repeat(10)), 'x'.repeat(10))
  const long = displayName('x'.repeat(80), 20)
  assert.equal([...long].length, 20)
  assert.ok(long.includes('…'))
  assert.ok(long.startsWith('x'))
})

test('video files show a cover, a silent clip and the length', () => {
  const root = tempRoot()
  try {
    const view = fileView({
      dir: '',
      file: 'clip.mp4',
      media: { kind: 'video', poster: 'asset:preview/p.jpg', gif: 'asset:preview/l.gif', width: 320, height: 240, duration: 12.4, aspect: 4 / 3, bytes: 900000 },
    }, root, caps())
    const nodes = walk(view)
    const gallery = nodes.find((n) => n.type === 'gallery')
    assert.deepEqual(gallery.items.map((i) => i.src), ['asset:preview/l.gif', 'asset:preview/p.jpg'])
    const kv = nodes.find((n) => n.type === 'keyValue')
    assert.ok(kv.items.some(([label, value]) => label === '时长' && value === '0:12'))
    assert.ok(kv.items.some(([label, value]) => label === '分辨率' && value === '320×240'))
    assert.ok(nodes.some((n) => n.type === 'callout' && n.tone === 'info'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('old apps get a plain picture instead of a gallery', () => {
  const root = tempRoot()
  try {
    const nodes = walk(fileView({
      dir: '',
      file: 'clip.mp4',
      media: { kind: 'video', poster: 'asset:preview/p.jpg', width: 320, height: 240, duration: 3, aspect: 4 / 3, bytes: 1 },
    }, root, caps({ components: undefined })))
    assert.ok(!nodes.some((n) => n.type === 'gallery'))
    const image = nodes.find((n) => n.type === 'image')
    assert.equal(image.src, 'asset:preview/p.jpg')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a media conversion failure is explained', () => {
  const root = tempRoot()
  try {
    const nodes = walk(fileView({ dir: '', file: 'x.heic', media: { error: 'convert-failed' } }, root, caps()))
    const callout = nodes.find((n) => n.type === 'callout')
    assert.equal(callout.tone, 'bad')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// 用官方工具包的 App 视图解析器复核一遍媒体视图（找不到工具包就跳过）。
const HOME = process.env.HOME ?? ''
const KITS = [
  process.env.DSH_PLUGIN_KIT,
  join(process.env.DSH_HOME ?? (HOME === '' ? '' : join(HOME, '.dsh')), 'skills', 'dsh-go-plugin', 'kit'),
  '/root/.dsh/skills/dsh-go-plugin/kit',
].filter((kit) => typeof kit === 'string' && kit !== '')

let checkView
for (const dir of KITS) {
  if (!existsSync(join(dir, 'lib', 'view-check.js'))) continue
  try {
    checkView = (await import(pathToFileURL(join(dir, 'lib', 'view-check.js')).href)).checkView
    break
  } catch {
    /* 试下一个 */
  }
}

test('media views pass the app view parser', { skip: checkView === undefined ? 'dsh-go-plugin 工具包不在本机' : false }, () => {
  const root = tempRoot()
  try {
    const cases = [
      { kind: 'image', asset: 'asset:preview/abc.jpg', width: 640, height: 480, aspect: 640 / 480, bytes: 123 },
      { kind: 'video', poster: 'asset:preview/p.jpg', gif: 'asset:preview/l.gif', width: 320, height: 240, duration: 12.4, aspect: 4 / 3, bytes: 99 },
      { kind: 'video', poster: 'asset:preview/p.jpg', width: 320, height: 240, duration: 12.4, aspect: 4 / 3, bytes: 99 },
    ]
    for (const media of cases) {
      const result = checkView(fileView({ dir: '', file: `f.${media.kind === 'image' ? 'png' : 'mp4'}`, media }, root, caps()), { budget: 'panel', lang: 'zh' })
      assert.equal(result.fatal, false, JSON.stringify(result.issues))
      assert.equal(result.ok, true, JSON.stringify(result.issues))
      assert.ok(result.issues.every((i) => i.kind === 'note'), JSON.stringify(result.issues))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('folder images show as thumbnails instead of list rows', () => {
  const root = tempRoot()
  const cache = join(root, '.thumbs')
  try {
    writeFileSync(join(root, 'shot.png'), Buffer.from(PNG_1PX, 'base64'))
    const nodes = walk(browseView({ dir: '' }, root, caps(), cache))
    const gallery = nodes.find((n) => n.type === 'gallery')
    assert.ok(gallery, 'thumbnail rendered')
    assert.ok(gallery.items.some((item) => /^asset:preview\/[0-9a-f]+\.png$/.test(item.src)))
    const thumbRow = nodes.find((n) => n.type === 'row' && n.children?.some((c) => c.type === 'gallery'))
    assert.ok(thumbRow, 'thumbnail sits in a fake list row')
    assert.ok(thumbRow.children.some((c) => c.type === 'stack' && c.children.some((t) => t.type === 'text')))
    assert.equal(gallery.items[0].action, undefined)
    assert.equal(gallery.items[0].action, undefined, 'tap opens the app viewer')
    const list = nodes.find((n) => n.type === 'list')
    assert.ok(list)
    assert.ok(!list.items.some((i) => i.title === 'shot.png'), 'image row is replaced by its thumbnail')
    assert.ok(list.items.some((i) => i.title === 'a.txt'))
    assert.ok(list.items.some((i) => i.title === 'docs'))
    assert.ok(nodes.some((n) => n.type === 'text' && String(n.text).includes('图片')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('old apps keep images in the plain list', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'shot.png'), Buffer.from(PNG_1PX, 'base64'))
    const nodes = walk(browseView({ dir: '' }, root, caps({ components: undefined }), join(root, '.thumbs')))
    assert.ok(!nodes.some((n) => n.type === 'gallery'))
    const list = nodes.find((n) => n.type === 'list')
    assert.ok(list.items.some((i) => i.title === 'shot.png'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a folder with many images falls back to the grid', () => {
  const root = tempRoot()
  const cache = join(root, '.thumbs')
  try {
    for (let i = 0; i < 12; i += 1) writeFileSync(join(root, `p${String(i).padStart(2, '0')}.png`), Buffer.from(PNG_1PX, 'base64'))
    const nodes = walk(browseView({ dir: '' }, root, caps(), cache))
    const galleries = nodes.filter((n) => n.type === 'gallery')
    assert.equal(galleries.length, 1, 'one grid gallery, no per-image rows')
    assert.ok(galleries[0].items.length > 10)
    assert.ok(!nodes.some((n) => n.type === 'row' && n.children?.some((c) => c.type === 'gallery')))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
