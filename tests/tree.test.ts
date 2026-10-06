import { describe, expect, test } from 'claude-code/testing'

import type { Tree } from '../types'
import {
  addNode,
  createOutline,
  deleteOutline,
  emptyTree,
  fallbackTitle,
  loadTree,
  markPromoted,
  mutateTree,
  normalizeTree,
  pathTo,
  refreshOutline,
  removeNode,
  rootOf,
  setActive,
  sideHistory,
  treeKey,
  updateNode,
  visibleRoots,
  type NewNode,
} from '../hooks/tree'

const A = 'session-A'
const B = 'session-B'

const n = (id: string, sessionId = A, at = 1): NewNode => ({
  id,
  question: `question ${id}`,
  anchor: { sessionId, turnId: null, at, mainSnippet: '' },
  route: { label: 'sidebar_knowledge', confidence: 0.9, source: 'jev' },
  answeredBy: 'claude-fork',
  answer: `answer ${id}`,
})

const add = (t: Tree, id: string, attach: Parameters<typeof addNode>[3], sessionId = A, at = 1) =>
  addNode(t, sessionId, n(id, sessionId, at), attach).tree

describe('addNode', () => {
  test('a new root becomes the session activeThread', () => {
    const t = add(emptyTree(), 'r1', { kind: 'root' })
    expect(t.roots).toEqual(['r1'])
    expect(t.nodes.r1?.parentId).toBeNull()
    expect(t.activeThread[A]).toBe('r1')
  })

  test('three follow-ups chain under the same thread', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'f1', { kind: 'followup' })
    t = add(t, 'f2', { kind: 'followup' })
    t = add(t, 'f3', { kind: 'followup' })
    expect(pathTo(t, 'f3').map(x => x.id)).toEqual(['r1', 'f1', 'f2', 'f3'])
    expect(t.roots).toEqual(['r1'])
    expect(t.activeThread[A]).toBe('f3')
  })

  test('a follow-up with no activeThread becomes a root', () => {
    const t = add(emptyTree(), 'x', { kind: 'followup' })
    expect(t.roots).toEqual(['x'])
  })

  test('re-selecting an upper node adds a sibling under it', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'f1', { kind: 'followup' })
    t = add(t, 'f2', { kind: 'followup' })
    t = setActive(t, A, 'r1')
    t = add(t, 'g1', { kind: 'followup' })
    expect(t.nodes.r1?.children).toEqual(['f1', 'g1'])
    expect(t.nodes.g1?.parentId).toBe('r1')
  })

  test('activeThread is per session', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' }, A)
    t = add(t, 'r2', { kind: 'root' }, B)
    t = add(t, 'fa', { kind: 'followup' }, A)
    expect(t.nodes.fa?.parentId).toBe('r1')
    expect(t.activeThread[B]).toBe('r2')
  })

  test('explicit parent (pane follow-up box) ignores activeThread', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'r2', { kind: 'root' })
    t = add(t, 'u', { kind: 'under', parentId: 'r1' })
    expect(t.nodes.u?.parentId).toBe('r1')
  })

  test('a missing parent falls back to a root', () => {
    const t = add(emptyTree(), 'u', { kind: 'under', parentId: 'gone' })
    expect(t.roots).toEqual(['u'])
  })

  test('does not mutate its input and refuses duplicate ids', () => {
    const t0 = add(emptyTree(), 'r1', { kind: 'root' })
    const snapshot = JSON.stringify(t0)
    add(t0, 'f1', { kind: 'followup' })
    expect(JSON.stringify(t0)).toBe(snapshot)
    expect(() => add(t0, 'r1', { kind: 'root' })).toThrow('already exists')
  })

  test('title falls back to the first 12 characters of the question', () => {
    expect(fallbackTitle('為什麼 TCP 需要三次握手才能建立連線')).toBe('為什麼 TCP 需要三次')
    expect([...fallbackTitle('😀'.repeat(20))]).toHaveLength(12)
  })
})

describe('history and lookup', () => {
  test('sideHistory is the answered chain root → node', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'f1', { kind: 'followup' })
    t = updateNode(t, 'f1', { answer: '' })
    expect(sideHistory(t, 'f1').map(x => x.question)).toEqual(['question r1'])
    expect(sideHistory(t, null)).toEqual([])
    expect(rootOf(t, 'f1')).toBe('r1')
  })

  test('visibleRoots filters by session', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' }, A)
    t = add(t, 'r2', { kind: 'root' }, B)
    expect(visibleRoots(t).map(r => r.id)).toEqual(['r1', 'r2'])
    expect(visibleRoots(t, B).map(r => r.id)).toEqual(['r2'])
  })

  test('updateNode clips titles to 12 characters', () => {
    const t = updateNode(add(emptyTree(), 'r1', { kind: 'root' }), 'r1', { title: '一二三四五六七八九十甲乙丙', summary: 's' })
    expect(t.nodes.r1?.title).toBe('一二三四五六七八九十甲乙')
    expect(t.nodes.r1?.summary).toBe('s')
  })

  test('markPromoted records time and target', () => {
    const t = markPromoted(add(emptyTree(), 'r1', { kind: 'root' }), 'r1', B, 99)
    expect(t.nodes.r1?.promotedAt).toBe(99)
    expect(t.nodes.r1?.promotedTo).toBe(B)
  })
})

describe('outlines', () => {
  const three = () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'c1', { kind: 'followup' })
    t = add(t, 'r2', { kind: 'root' })
    t = add(t, 'r3', { kind: 'root' })
    return t
  }

  test('groups roots and tags them with outlineId', () => {
    const { tree, outline, moved } = createOutline(three(), { id: 'o1', title: 'T', outline: 'O', memberIds: ['r1', 'r2'], createdAt: 5 })
    expect(outline.memberIds).toEqual(['r1', 'r2'])
    expect(tree.nodes.r1?.outlineId).toBe('o1')
    expect(moved).toEqual([])
  })

  test('only roots may be members; an outline cannot be one', () => {
    const t = three()
    expect(() => createOutline(t, { id: 'o1', title: '', outline: '', memberIds: ['c1'], createdAt: 0 })).toThrow('not a root')
    const t1 = createOutline(t, { id: 'o1', title: '', outline: '', memberIds: ['r1'], createdAt: 0 }).tree
    expect(() => createOutline(t1, { id: 'o2', title: '', outline: '', memberIds: ['o1'], createdAt: 0 })).toThrow('outline')
    expect(() => createOutline(t, { id: 'o3', title: '', outline: '', memberIds: [], createdAt: 0 })).toThrow('at least one')
  })

  test('a root in another outline is moved; an emptied outline is removed', () => {
    let t = createOutline(three(), { id: 'o1', title: '', outline: '', memberIds: ['r1'], createdAt: 0 }).tree
    const r = createOutline(t, { id: 'o2', title: '', outline: '', memberIds: ['r1', 'r2'], createdAt: 1 })
    t = r.tree
    expect(r.moved).toEqual(['r1'])
    expect(t.outlines.o1).toBeUndefined()
    expect(t.nodes.r1?.outlineId).toBe('o2')
  })

  test('a new follow-up under a member marks the outline stale; refresh clears it', () => {
    let t = createOutline(three(), { id: 'o1', title: '', outline: 'v1', memberIds: ['r1'], createdAt: 0 }).tree
    t = setActive(t, A, 'c1')
    t = add(t, 'c2', { kind: 'followup' }, A, 42)
    expect(t.outlines.o1?.staleSince).toBe(42)
    t = refreshOutline(t, 'o1', 'v2')
    expect(t.outlines.o1?.staleSince).toBeNull()
    expect(t.outlines.o1?.outline).toBe('v2')
  })

  test('deleting an outline leaves the roots intact', () => {
    let t = createOutline(three(), { id: 'o1', title: '', outline: '', memberIds: ['r1', 'r2'], createdAt: 0 }).tree
    t = deleteOutline(t, 'o1')
    expect(t.outlines).toEqual({})
    expect(t.nodes.r1?.outlineId).toBeNull()
    expect(t.roots).toEqual(['r1', 'r2', 'r3'])
  })
})

describe('removeNode', () => {
  test('removes the subtree and repoints activeThread to the parent', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'f1', { kind: 'followup' })
    t = add(t, 'f2', { kind: 'followup' })
    t = removeNode(t, 'f1')
    expect(Object.keys(t.nodes)).toEqual(['r1'])
    expect(t.nodes.r1?.children).toEqual([])
    expect(t.activeThread[A]).toBe('r1')
  })

  test('removing a root drops it from roots and outlines', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = add(t, 'r2', { kind: 'root' })
    t = createOutline(t, { id: 'o1', title: '', outline: '', memberIds: ['r1'], createdAt: 0 }).tree
    t = removeNode(t, 'r1')
    expect(t.roots).toEqual(['r2'])
    expect(t.outlines.o1).toBeUndefined()
    expect(t.activeThread[A]).toBe('r2')
  })
})

describe('store', () => {
  test('normalizeTree tolerates junk', () => {
    expect(normalizeTree(undefined)).toEqual(emptyTree())
    expect(normalizeTree({ version: 1 })).toEqual(emptyTree())
    expect(normalizeTree({ version: 2, roots: ['x'] }).roots).toEqual(['x'])
  })

  test('treeKey strips trailing separators', () => {
    expect(treeKey('C:\\proj\\')).toBe('tree:C:\\proj')
    expect(treeKey('/home/me/proj/')).toBe('tree:/home/me/proj')
  })

})

test('mutateTree round-trips through a KV (JSON copies, as $.store keeps them)', async () => {
  const mem = new Map<string, string>()
  const kv = { get: async (k: string) => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined), set: async (k: string, v: unknown) => void mem.set(k, JSON.stringify(v)) }
  await mutateTree(kv, 'tree:/p', t => addNode(t, A, n('r1'), { kind: 'root' }).tree)
  await mutateTree(kv, 'tree:/p', t => addNode(t, B, n('r2', B), { kind: 'root' }).tree)
  const back = await loadTree(kv, 'tree:/p')
  expect(back.roots).toEqual(['r1', 'r2'])
  expect(back.activeThread).toEqual({ [A]: 'r1', [B]: 'r2' })
})
