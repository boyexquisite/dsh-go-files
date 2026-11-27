import test from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
