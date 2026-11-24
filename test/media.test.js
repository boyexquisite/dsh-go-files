// 图片 / 视频预览的转换测试。机器上没有 ffmpeg 时整组跳过。
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CACHE_KEEP,
  CACHE_TTL_MS,
  MAX_ASSET_BYTES,
  MAX_PIXELS,
  MAX_SIDE,
  cacheDirOf,
  fitBox,
  formatDuration,
  mediaKind,
  prepareImage,
  prepareFolderThumbs,
  prepareImageGallery,
  prepareMedia,
  prepareVideo,
  probe,
  pruneCache,
} from '../lib/media.js'
import { rootOf } from '../lib/workspace.js'

function has(cmd) {
  try {
    execFileSync(cmd, ['-version'], { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

const FFMPEG = has('ffmpeg') && has('ffprobe')
const SKIP = FFMPEG ? false : '没有 ffmpeg / ffprobe'

function tmp(prefix) {
  return rootOf(mkdtempSync(join(tmpdir(), prefix)))
}

function makeImage(dir, name, width, height) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=${width}x${height}`, '-frames:v', '1', join(dir, name)], { timeout: 20000 })
}

function makeVideo(dir, name, seconds = 2) {
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10', '-t', String(seconds), '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', join(dir, name)], { timeout: 20000 })
}

function fixtures() {
  const root = tmp('dsh-media-')
  const cache = join(tmp('dsh-cache-'), 'preview')
  mkdirSync(cache, { recursive: true })
  return { root, cache }
}

test('mediaKind recognises known extensions', () => {
  assert.equal(mediaKind('a.png'), 'image')
  assert.equal(mediaKind('a.JPG'), 'image')
  assert.equal(mediaKind('a.gif'), 'image')
  assert.equal(mediaKind('a.mp4'), 'video')
  assert.equal(mediaKind('a.MOV'), 'video')
  assert.equal(mediaKind('a.txt'), undefined)
})

test('fitBox keeps sides and pixel count in budget', () => {
  assert.deepEqual(fitBox(640, 480), { width: 640, height: 480 })
  const big = fitBox(8000, 6000)
  assert.ok(big.width <= MAX_SIDE && big.height <= MAX_SIDE)
  assert.ok(big.width * big.height <= MAX_PIXELS + 10)
  assert.equal(fitBox(0, 0), undefined)
})

test('formatDuration writes minutes and hours', () => {
  assert.equal(formatDuration(0), '')
  assert.equal(formatDuration(5), '0:05')
  assert.equal(formatDuration(65), '1:05')
  assert.equal(formatDuration(3725), '1:02:05')
})

test('prepareImage copies a small image untouched', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'small.png', 640, 480)
    const before = statSync(join(root, 'small.png')).size
    const result = prepareImage(root, 'small.png', cache)
    assert.equal(result.kind, 'image')
    assert.match(result.asset, /^asset:preview\/[0-9a-f]+\.png$/)
    assert.equal(result.width, 640)
    assert.equal(result.height, 480)
    assert.ok(Math.abs(result.aspect - 640 / 480) < 0.01)
    assert.equal(result.bytes, before)
    const file = join(cache, result.asset.slice('asset:preview/'.length))
    assert.ok(existsSync(file))
    assert.equal(statSync(file).size, before)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareImage re-encodes an oversized image into the budget', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'huge.png', 5000, 4000)
    const result = prepareImage(root, 'huge.png', cache)
    assert.equal(result.kind, 'image')
    assert.match(result.asset, /\.jpg$/)
    assert.ok(result.width <= MAX_SIDE && result.height <= MAX_SIDE)
    assert.ok(result.width * result.height <= MAX_PIXELS + 1000)
    const file = join(cache, result.asset.slice('asset:preview/'.length))
    assert.ok(statSync(file).size <= MAX_ASSET_BYTES)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareImage never serves or overwrites through a cache symlink', () => {
  const { root, cache } = fixtures()
  const outside = tmp('dsh-cache-outside-')
  try {
    writeFileSync(join(root, 'small.png'), 'new-image')
    const first = prepareImage(root, 'small.png', cache, { skipProbe: true })
    const target = join(cache, first.asset.slice('asset:preview/'.length))
    unlinkSync(target)
    writeFileSync(join(outside, 'secret'), 'do-not-change')
    symlinkSync(join(outside, 'secret'), target)
    const second = prepareImage(root, 'small.png', cache, { skipProbe: true })
    assert.equal(second.error, 'denied')
    assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'do-not-change')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('concurrent image conversions use isolated temporary outputs', { skip: SKIP }, async () => {
  const { root, cache } = fixtures()
  const tools = tmp('dsh-ffmpeg-wrapper-')
  const log = join(tools, 'outputs.log')
  const wrapper = join(tools, 'ffmpeg-wrapper.sh')
  try {
    makeImage(root, 'huge.png', 5000, 4000)
    writeFileSync(wrapper, `#!/bin/sh\nfor last do :; done\nprintf '%s\\n' "$last" >> ${JSON.stringify(log)}\nexec ffmpeg "$@"\n`, { mode: 0o755 })
    const moduleUrl = new URL('../lib/media.js', import.meta.url).href
    const code = `import { prepareImage } from ${JSON.stringify(moduleUrl)}; const r = prepareImage(process.argv[1], 'huge.png', process.argv[2]); if (r.error) { console.error(r.error); process.exit(2) }`
    const runChild = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', code, root, cache], { env: { ...process.env, FFMPEG_PATH: wrapper } })
      let stderr = ''
      child.stderr.on('data', (chunk) => { stderr += chunk })
      child.on('error', reject)
      child.on('exit', (status) => status === 0 ? resolve() : reject(new Error(`child ${status}: ${stderr}`)))
    })
    await Promise.all([runChild(), runChild()])
    const outputs = readFileSync(log, 'utf8').trim().split('\n')
    assert.equal(outputs.length, 2)
    assert.notEqual(outputs[0], outputs[1], 'each process must write a private temporary file')
    assert.equal(readdirSync(cache).filter((name) => !name.startsWith('.')).length, 1)
    assert.equal(readdirSync(cache).filter((name) => name.startsWith('.')).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
    rmSync(tools, { recursive: true, force: true })
  }
})

test('prepareImage rejects paths outside the workspace', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    assert.equal(prepareImage(root, '../x.png', cache).error, 'denied')
    assert.equal(prepareImage(root, 'missing.png', cache).error, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareVideo makes a poster and a silent clip', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeVideo(root, 'clip.mp4', 2)
    const info = probe(join(root, 'clip.mp4'))
    assert.ok(info.duration > 1)
    const result = prepareVideo(root, 'clip.mp4', cache)
    assert.equal(result.kind, 'video')
    assert.match(result.poster, /^asset:preview\/.*\.jpg$/)
    assert.ok(result.duration > 1)
    assert.equal(result.width, 320)
    assert.equal(result.height, 240)
    const poster = join(cache, result.poster.slice('asset:preview/'.length))
    assert.ok(existsSync(poster))
    if (result.gif) {
      assert.match(result.gif, /\.gif$/)
      const gif = join(cache, result.gif.slice('asset:preview/'.length))
      assert.ok(statSync(gif).size <= MAX_ASSET_BYTES)
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareMedia maps kinds and ignores text files', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    writeFileSync(join(root, 'a.txt'), 'hi')
    makeImage(root, 'b.png', 32, 32)
    assert.equal(prepareMedia(root, 'a.txt', cache), undefined)
    assert.equal(prepareMedia(root, 'b.png', cache).kind, 'image')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('cacheDirOf points inside the plugin assets', () => {
  assert.equal(cacheDirOf('/p'), join('/p', 'assets', 'preview'))
})

test('pruneCache drops expired files and keeps the newest ones', () => {
  const dir = tmp('dsh-prune-')
  try {
    const now = Date.now()
    writeFileSync(join(dir, 'old.jpg'), 'x')
    const old = now - CACHE_TTL_MS - 60_000
    utimesSync(join(dir, 'old.jpg'), old / 1000, old / 1000)
    for (let i = 0; i < CACHE_KEEP + 3; i += 1) {
      const path = join(dir, `f${i}.jpg`)
      writeFileSync(path, 'x')
      utimesSync(path, (now - i * 1000) / 1000, (now - i * 1000) / 1000)
    }
    pruneCache(dir, now)
    const names = readdirSync(dir)
    assert.ok(!names.includes('old.jpg'))
    assert.ok(names.length <= CACHE_KEEP)
    assert.ok(!names.includes(`f${CACHE_KEEP}.jpg`))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('preparing a preview prunes the cache', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'small.png', 32, 32)
    for (let i = 0; i < CACHE_KEEP + 5; i += 1) writeFileSync(join(cache, `old${i}.jpg`), 'x')
    assert.equal(readdirSync(cache).length, CACHE_KEEP + 5)
    prepareImage(root, 'small.png', cache)
    assert.ok(readdirSync(cache).length <= CACHE_KEEP)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareImageGallery puts the opened image first and adds siblings', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'b.png', 64, 48)
    makeImage(root, 'a.png', 32, 32)
    makeImage(root, 'c.png', 48, 64)
    writeFileSync(join(root, 'note.txt'), 'x')
    const { opened, items } = prepareImageGallery(root, 'b.png', cache, { limit: 9, budgetMs: 5000 })
    assert.equal(opened.kind, 'image')
    assert.equal(items.length, 3)
    assert.equal(items[0].name, 'b.png')
    assert.deepEqual(items.map((i) => i.name).sort(), ['a.png', 'b.png', 'c.png'])
    for (const item of items) {
      assert.match(item.asset, /^asset:preview\/[0-9a-f]+\.png$/)
      assert.ok(existsSync(join(cache, item.asset.slice('asset:preview/'.length))))
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareImageGallery respects the limit and a broken image', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'a.png', 16, 16)
    makeImage(root, 'b.png', 16, 16)
    writeFileSync(join(root, 'broken.png'), 'not an image')
    const limited = prepareImageGallery(root, 'a.png', cache, { limit: 1, budgetMs: 5000 })
    assert.equal(limited.items.length, 1)
    const withBroken = prepareImageGallery(root, 'a.png', cache, { limit: 9, budgetMs: 5000 })
    const names = withBroken.items.map((i) => i.name)
    assert.equal(names[0], 'a.png')
    assert.ok(names.includes('b.png'))
    assert.ok(names.length <= 3)
    const missing = prepareImageGallery(root, 'nope.png', cache)
    assert.equal(missing.items.length, 0)
    assert.equal(missing.opened.error, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareFolderThumbs only picks image files', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    makeImage(root, 'b.png', 16, 16)
    makeImage(root, 'a.jpg', 16, 16)
    writeFileSync(join(root, 'notes.txt'), 'x')
    mkdirSync(join(root, 'sub'), { recursive: true })
    const items = prepareFolderThumbs(root, '', cache)
    assert.deepEqual(items.map((i) => i.name), ['a.jpg', 'b.png'])
    for (const item of items) assert.ok(existsSync(join(cache, item.asset.slice('asset:preview/'.length))))
    const limited = prepareFolderThumbs(root, '', cache, { limit: 1 })
    assert.equal(limited.length, 1)
    assert.deepEqual(prepareFolderThumbs(root, 'missing', cache), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})

test('prepareVideo skips gif without ENOENT for >1080p videos', { skip: SKIP }, () => {
  const { root, cache } = fixtures()
  try {
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=2560x1440:rate=5',
      '-t', '1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', join(root, 'uhd.mp4'),
    ], { timeout: 30000 })
    const result = prepareVideo(root, 'uhd.mp4', cache)
    assert.equal(result.kind, 'video')
    assert.equal(result.gif, undefined)
    assert.ok(result.poster.startsWith('asset:preview/'))
    const posterFile = join(cache, result.poster.slice('asset:preview/'.length))
    assert.ok(existsSync(posterFile))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(join(cache, '..'), { recursive: true, force: true })
  }
})
