import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../lib/index.js'
import { moveFile, resolveInside, rootOf, safeName, savePicked } from '../lib/workspace.js'

function setup() {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-safety-')))
  let panel
  apply({ inject: (_, fn) => fn({ dshGo: { panel: (_, def) => { panel = def } } }) }, { root })
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

test('atomic move refuses a target created immediately before the syscall', { skip: process.platform !== 'linux' }, () => {
  const root = rootOf(mkdtempSync(join(tmpdir(), 'files-race-')))
  const oldPath = process.env.PATH
  try {
    mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dst')); mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'src', 'a'), 'source')
    const shim = join(root, 'bin', 'python3')
    writeFileSync(shim, '#!/bin/sh\nprintf rival > "$4"\nexec /usr/bin/python3 "$@"\n')
    chmodSync(shim, 0o755)
    process.env.PATH = join(root, 'bin')
    assert.equal(moveFile(root, 'src/a', 'dst').error, 'exists')
    assert.equal(readFileSync(join(root, 'src', 'a'), 'utf8'), 'source')
    assert.equal(readFileSync(join(root, 'dst', 'a'), 'utf8'), 'rival')
    process.env.PATH = join(root, 'missing')
    assert.equal(moveFile(root, 'src/a', '').error, 'unsupported')
    assert.equal(readFileSync(join(root, 'src', 'a'), 'utf8'), 'source')
    assert.equal(existsSync(join(root, 'a')), false)
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath
    rmSync(root, { recursive: true, force: true })
  }
})
