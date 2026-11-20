import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dateFolder,
  humanSize,
  iconOf,
  languageOf,
  listDir,
  previewFile,
  relativeOf,
  resolveInside,
  rootOf,
  safeName,
  savePicked,
  shortTime,
  uniquePath,
  UPLOAD_DIR,
} from '../lib/workspace.js'

function tempRoot() {
  return rootOf(mkdtempSync(join(tmpdir(), 'dsh-ws-')))
}

test('resolveInside stays inside the workspace', () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'a', 'b'), { recursive: true })
    writeFileSync(join(root, 'a', 'b', 'x.txt'), 'hi')
    assert.equal(resolveInside(root, 'a/b/x.txt'), join(root, 'a/b/x.txt'))
    assert.equal(resolveInside(root, ''), root)
    assert.equal(resolveInside(root, '..'), undefined)
    assert.equal(resolveInside(root, '../etc/passwd'), undefined)
    assert.equal(resolveInside(root, '/etc/passwd'), undefined)
    assert.equal(resolveInside(root, 'a/missing.txt'), join(root, 'a/missing.txt'))
    assert.equal(resolveInside(root, 'a\0b'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveInside refuses a symlink that leads outside', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    writeFileSync(join(outside, 'secret.txt'), 'nope')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    assert.equal(resolveInside(root, 'link.txt'), undefined)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('listDir sorts folders first, counts, and hides .git', () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, '.git', 'objects'), { recursive: true })
    mkdirSync(join(root, 'zeta'), { recursive: true })
    mkdirSync(join(root, 'Alpha'), { recursive: true })
    writeFileSync(join(root, 'b.txt'), 'bbb')
    writeFileSync(join(root, 'a.txt'), 'a')
    const listing = listDir(root, '')
    assert.equal(listing.error, undefined)
    assert.deepEqual(listing.entries.map((e) => e.name), ['Alpha', 'zeta', 'a.txt', 'b.txt'])
    assert.equal(listing.total, 4)
    assert.equal(listing.totalDir, 2)
    assert.equal(listing.totalFile, 2)
    assert.equal(listing.entries[0].count, 0)
    assert.equal(listing.entries[2].size, 1)
    assert.equal(listing.entries[2].rel, 'a.txt')
    assert.equal(listing.more, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listDir caps at LIST_LIMIT and reports the rest', () => {
  const root = tempRoot()
  try {
    for (let i = 0; i < 55; i += 1) writeFileSync(join(root, `f${String(i).padStart(2, '0')}.txt`), 'x')
    const listing = listDir(root, '')
    assert.equal(listing.total, 55)
    assert.equal(listing.entries.length, 50)
    assert.equal(listing.more, 5)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listDir reports missing and non-directory paths', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'file.txt'), 'x')
    assert.equal(listDir(root, 'file.txt').error, 'not-directory')
    assert.equal(listDir(root, 'nope').error, 'missing')
    assert.equal(listDir(root, '../x').error, 'denied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('previewFile reads text, flags binaries and truncates long files', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'a.md'), '# hello\nworld')
    const text = previewFile(root, 'a.md')
    assert.equal(text.text, '# hello\nworld')
    assert.equal(text.language, 'markdown')
    assert.equal(text.truncated, false)
    assert.ok(text.mtime > 0)

    writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    assert.equal(previewFile(root, 'bin.dat').error, 'binary')

    writeFileSync(join(root, 'long.txt'), 'x'.repeat(8000))
    const long = previewFile(root, 'long.txt')
    assert.equal(long.text.length, 6000)
    assert.equal(long.truncated, true)

    assert.equal(previewFile(root, 'missing.txt').error, 'missing')
    assert.equal(previewFile(root, '').error, 'directory')
    assert.equal(previewFile(root, '../x').error, 'denied')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('safeName strips paths and control characters', () => {
  assert.equal(safeName('photo.jpg'), 'photo.jpg')
  assert.equal(safeName('/sdcard/DCIM/photo.jpg'), 'photo.jpg')
  assert.equal(safeName('..\\..\\etc\\passwd'), 'passwd')
  assert.equal(safeName('  spaced.txt  '), 'spaced.txt')
  assert.equal(safeName('..'), 'file')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName('a\u0000b.txt'), 'ab.txt')
  assert.equal(safeName('x'.repeat(300)).length, 100)
})

test('uniquePath never overwrites', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'a.txt'), '1')
    const second = uniquePath(root, 'a.txt')
    assert.equal(second, join(root, 'a (2).txt'))
    writeFileSync(second, '2')
    assert.equal(uniquePath(root, 'a.txt'), join(root, 'a (3).txt'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('savePicked writes into uploads/<date>/ and reports results', () => {
  const root = tempRoot()
  try {
    const files = [
      { handle: 'h1', name: '/sdcard/a.txt' },
      { handle: 'h2', name: 'a.txt' },
      { handle: 'h3', name: 'bad.txt' },
    ]
    const data = { h1: Buffer.from('one'), h2: Buffer.from('two') }
    const result = savePicked(files, (handle) => {
      if (!data[handle]) throw new Error('gone')
      return data[handle]
    }, { root, now: new Date(2026, 10, 20, 12) })
    assert.equal(result.folder, `${UPLOAD_DIR}/2026-11-20`)
    assert.deepEqual(result.saved.map((f) => f.name), ['a.txt', 'a (2).txt'])
    assert.deepEqual(result.failed.map((f) => f.name), ['bad.txt'])
    assert.equal(listDir(root, result.folder).entries.length, 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('savePicked refuses empty and non-buffer reads', () => {
  const root = tempRoot()
  try {
    const result = savePicked([{ handle: 'h', name: 'x' }], () => Buffer.alloc(0), { root })
    assert.equal(result.saved.length, 0)
    assert.equal(result.failed.length, 1)
    const bad = savePicked([{ handle: 'h', name: 'x' }], () => 'string', { root })
    assert.equal(bad.saved.length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('helpers format sizes, dates and languages', () => {
  assert.equal(dateFolder(new Date(2026, 0, 2)), '2026-01-02')
  assert.equal(humanSize(0), '0 B')
  assert.equal(humanSize(1536), '1.5 KB')
  assert.equal(humanSize(2 * 1024 * 1024), '2.0 MB')
  assert.equal(languageOf('a.js'), 'javascript')
  assert.equal(languageOf('a.unknown'), undefined)
  assert.equal(iconOf('a.png'), 'image')
  assert.equal(iconOf('a.zip'), 'zip')
  assert.equal(iconOf('a.unknown'), 'file')
  assert.match(shortTime(new Date(2026, 10, 20, 9, 5).getTime()), /^11-20 09:05$/)
  assert.equal(shortTime(0), '')
})

test('relativeOf maps absolute paths back to workspace relatives', () => {
  const root = '/work'
  assert.equal(relativeOf(root, '/work'), '')
  assert.equal(relativeOf(root, '/work/a/b.txt'), 'a/b.txt')
})
