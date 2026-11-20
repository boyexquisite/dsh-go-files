import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  dateFolder,
  deleteEmptyFolder,
  deleteFile,
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
  moveFile,
  workspaceRoot,
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

    // 没有 NUL 的二进制（很像 PDF / 压缩包）也该认出来
    writeFileSync(join(root, 'odd.bin'), Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f]))
    assert.equal(previewFile(root, 'odd.bin').error, 'binary')

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

test('workspaceRoot prefers env, then the DSH workspace registry', () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-home-'))
  try {
    mkdirSync(join(home, 'storages'), { recursive: true })
    const workspace = join(home, 'work')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      global: { workspaceIds: ['w1'] },
      tables: { workspaces: { w1: { path: workspace } } },
    }))
    const env = { DSH_HOME: home }
    assert.equal(workspaceRoot(env, '/nowhere'), workspace)
    assert.equal(workspaceRoot({ ...env, DSH_WORKSPACE_ROOT: '/explicit' }, '/nowhere'), '/explicit')
    assert.equal(workspaceRoot({ DSH_HOME: join(home, 'missing') }, '/nowhere'), process.cwd())
    // 注册表里的目录不在了，也退回 cwd
    writeFileSync(join(home, 'storages', 'workspace.json'), JSON.stringify({
      global: { workspaceIds: ['w2'] },
      tables: { workspaces: { w2: { path: '/definitely/not/here' } } },
    }))
    assert.equal(workspaceRoot(env, '/nowhere'), process.cwd())
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('savePicked reports a folder it cannot create', () => {
  const root = tempRoot()
  try {
    const blocker = join(root, 'uploads')
    writeFileSync(blocker, 'not a dir')
    const result = savePicked([{ handle: 'h', name: 'a.txt' }], () => Buffer.from('x'), { root, folder: 'uploads/2026-11-20' })
    assert.equal(result.error, 'mkdir')
    assert.equal(result.saved.length, 0)
    assert.equal(result.failed.length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleteFile removes a file but refuses folders, links and escapes', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    writeFileSync(join(root, 'a.txt'), 'x')
    mkdirSync(join(root, 'dir'))
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'))
    assert.equal(deleteFile(root, 'a.txt').name, 'a.txt')
    assert.ok(!existsSync(join(root, 'a.txt')))
    assert.equal(deleteFile(root, 'dir').error, 'not-file')
    assert.equal(deleteFile(root, 'link.txt').error, 'link')
    assert.equal(deleteFile(root, '../etc').error, 'denied')
    assert.equal(deleteFile(root, '').error, 'denied')
    assert.equal(deleteFile(root, 'nope').error, 'missing')
    assert.ok(existsSync(join(outside, 'secret.txt')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('deleteEmptyFolder only deletes empty folders', () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'empty'))
    mkdirSync(join(root, 'full'))
    writeFileSync(join(root, 'full', 'x.txt'), 'x')
    assert.equal(deleteEmptyFolder(root, 'empty').name, 'empty')
    assert.equal(deleteEmptyFolder(root, 'full').error, 'not-empty')
    assert.equal(deleteEmptyFolder(root, '').error, 'denied')
    assert.equal(deleteEmptyFolder(root, 'empty').error, 'missing')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('moveFile renames inside the workspace and never overwrites', () => {
  const root = tempRoot()
  try {
    mkdirSync(join(root, 'a'))
    mkdirSync(join(root, 'b'))
    writeFileSync(join(root, 'a', 'x.txt'), 'hello')
    const moved = moveFile(root, 'a/x.txt', 'b')
    assert.deepEqual(moved, { name: 'x.txt', dir: 'b' })
    writeFileSync(join(root, 'a', 'x.txt'), 'again')
    assert.equal(moveFile(root, 'a/x.txt', 'b').error, 'exists')
    assert.equal(moveFile(root, 'b/x.txt', 'b').error, 'same-dir')
    assert.equal(moveFile(root, 'a/x.txt', 'nope').error, 'no-target')
    assert.equal(moveFile(root, '../x', 'b').error, 'denied')
    assert.equal(moveFile(root, 'a/x.txt', '../out').error, 'no-target')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('deleteFile / deleteEmptyFolder / moveFile refuse a symlinked parent that leads outside', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    mkdirSync(join(outside, 'emptyd'))
    mkdirSync(join(root, 'ok'))
    symlinkSync(outside, join(root, 'escape'))
    assert.equal(deleteFile(root, 'escape/secret.txt').error, 'denied')
    assert.equal(deleteEmptyFolder(root, 'escape/emptyd').error, 'denied')
    assert.equal(moveFile(root, 'escape/secret.txt', 'ok').error, 'denied')
    assert.ok(existsSync(join(outside, 'secret.txt')))
    assert.ok(existsSync(join(outside, 'emptyd')))
    // 目标目录是指向外面的符号链接也拒绝
    writeFileSync(join(root, 'ok', 'f.txt'), 'x')
    assert.equal(moveFile(root, 'ok/f.txt', 'escape').error, 'no-target')
    assert.ok(!existsSync(join(outside, 'f.txt')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('previewFile refuses a FIFO instead of hanging', () => {
  const root = tempRoot()
  try {
    execFileSync('mkfifo', [join(root, 'pipe')])
    assert.equal(previewFile(root, 'pipe').error, 'not-file')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('savePicked enforces a per-file size cap and stays inside the workspace', () => {
  const root = tempRoot()
  const outside = tempRoot()
  try {
    const big = Buffer.alloc(11, 1)
    const result = savePicked(
      [{ handle: 'a', name: 'big.bin' }, { handle: 'b', name: 'ok.bin' }, { handle: 'c', name: 'declared.bin', size: 999 }],
      (h) => (h === 'b' ? Buffer.alloc(5, 1) : big),
      { root, maxBytes: 10 },
    )
    assert.deepEqual(result.saved.map((f) => f.name), ['ok.bin'])
    assert.deepEqual(result.failed.map((f) => f.name), ['big.bin', 'declared.bin'])

    // uploads 是指向工作区外的符号链接：整批拒绝，外部目录不被写入
    symlinkSync(outside, join(root, 'linked'))
    const escaped = savePicked([{ handle: 'a', name: 'x.txt' }], () => Buffer.from('x'), { root, folder: 'linked/day' })
    assert.equal(escaped.error, 'mkdir')
    assert.equal(escaped.saved.length, 0)
    assert.ok(!existsSync(join(outside, 'day')))
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
