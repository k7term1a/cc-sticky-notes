import { describe, expect, test } from 'claude-code/testing'

import type { Tree } from '../types'
import type { KV } from '../hooks/ports'
import {
  addNode,
  createOutline,
  deleteOutline,
  emptyTree,
  fallbackTitle,
  loadTree,
  markPromoted,
  keys,
  migrateLegacy,
  mutateTree,
  normalizeRoot,
  pathTo,
  refreshOutline,
  removeNode,
  rootOf,
  setActive,
  saveDiff,
  sideHistory,
  updateNode,
  visibleRoots,
  type NewNode,
} from '../hooks/tree'

const A = 'session-A'
const B = 'session-B'

let clock = 0
const n = (id: string, sessionId = A, at = ++clock): NewNode => ({
  id,
  question: `question ${id}`,
  anchor: { sessionId, turnId: null, messageId: null, at, mainSnippet: '' },
  route: { label: 'sidebar_knowledge', confidence: 0.9, source: 'jev' },
  answeredBy: 'claude-fork',
  answer: `answer ${id}`,
})

const add = (t: Tree, id: string, attach: Parameters<typeof addNode>[3], sessionId = A, at = ++clock) =>
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

  test('markPromoted records time and the session it was promoted in', () => {
    const t = markPromoted(add(emptyTree(), 'r1', { kind: 'root' }), 'r1', B, 99)
    expect(t.nodes.r1?.promotedAt).toBe(99)
    expect(t.nodes.r1?.promotedIn).toBe(B)
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

/** An in-memory $.store: JSON copies, as the engine keeps them. */
function memKV(): KV & { mem: Map<string, string> } {
  const mem = new Map<string, string>()
  return {
    mem,
    get: async k => (mem.has(k) ? JSON.parse(mem.get(k)!) : undefined),
    set: async (k, v) => void mem.set(k, JSON.stringify(v)),
    delete: async k => void mem.delete(k),
    keys: async () => [...mem.keys()],
  }
}

describe('bookmarks', () => {
  test('a node added with makeActive: false leaves activeThread alone', () => {
    let t = add(emptyTree(), 'r1', { kind: 'root' })
    t = addNode(t, A, { ...n('bm'), promotedAt: 5, promotedIn: A }, { kind: 'root' }, { makeActive: false }).tree
    expect(t.activeThread[A]).toBe('r1')
    expect(t.nodes.bm).toMatchObject({ parentId: null, promotedAt: 5, promotedIn: A })
  })
})

describe('store layout (one key per node / outline / session)', () => {
  test('round-trips, deriving roots and children', async () => {
    const kv = memKV()
    await mutateTree(kv, '/p/', t => add(add(t, 'r1', { kind: 'root' }), 'c1', { kind: 'followup' }))
    await mutateTree(kv, '/p', t => add(t, 'r2', { kind: 'root' }, B))
    const back = await loadTree(kv, '/p')
    expect(back.roots).toEqual(['r1', 'r2'])
    expect(back.nodes.r1?.children).toEqual(['c1'])
    expect(back.activeThread).toEqual({ [A]: 'c1', [B]: 'r2' })
    expect([...kv.mem.keys()].sort()).toEqual([keys.active('/p', A), keys.active('/p', B), keys.node('/p', 'c1'), keys.node('/p', 'r1'), keys.node('/p', 'r2')].sort())
  })

  test('children are not stored, so adding a child never rewrites the parent key', async () => {
    const kv = memKV()
    await mutateTree(kv, '/p', t => add(t, 'r1', { kind: 'root' }))
    const parentBefore = kv.mem.get(keys.node('/p', 'r1'))
    await mutateTree(kv, '/p', t => add(t, 'c1', { kind: 'followup' }))
    expect(kv.mem.get(keys.node('/p', 'r1'))).toBe(parentBefore)
    expect(JSON.parse(parentBefore!).children).toEqual([])
  })

  test('two sessions writing at once both survive (the M0 race, now on separate keys)', async () => {
    const kv = memKV()
    await mutateTree(kv, '/p', t => add(t, 'r1', { kind: 'root' }))
    // both load the same snapshot before either writes
    const a0 = await loadTree(kv, '/p')
    const b0 = await loadTree(kv, '/p')
    const a1 = add(setActive(a0, A, 'r1'), 'fromA', { kind: 'followup' }, A)
    const b1 = add(setActive(b0, B, 'r1'), 'fromB', { kind: 'followup' }, B)
    await saveDiff(kv, '/p', a0, a1)
    await saveDiff(kv, '/p', b0, b1)
    const back = await loadTree(kv, '/p')
    expect(back.nodes.r1?.children).toEqual(['fromA', 'fromB'])
    expect(back.activeThread).toEqual({ [A]: 'fromA', [B]: 'fromB' })
  })

  test('removed nodes and outlines are deleted; tags go to meta', async () => {
    const kv = memKV()
    await mutateTree(kv, '/p', t => createOutline(add(add(t, 'r1', { kind: 'root' }), 'r2', { kind: 'root' }), { id: 'o1', title: '', outline: '', memberIds: ['r1'], createdAt: 0 }).tree)
    expect(kv.mem.has(keys.outline('/p', 'o1'))).toBe(true)
    await mutateTree(kv, '/p', t => ({ ...removeNode(t, 'r1'), tags: ['db'] }))
    expect(kv.mem.has(keys.node('/p', 'r1'))).toBe(false)
    expect(kv.mem.has(keys.outline('/p', 'o1'))).toBe(false)
    expect(JSON.parse(kv.mem.get(keys.meta('/p'))!)).toEqual({ version: 2, tags: ['db'], mainDigest: null })
  })

  test('projects do not see each other; a node whose parent vanished shows as a root', async () => {
    const kv = memKV()
    await mutateTree(kv, '/p', t => add(add(t, 'r1', { kind: 'root' }), 'c1', { kind: 'followup' }))
    await mutateTree(kv, '/q', t => add(t, 'other', { kind: 'root' }))
    expect((await loadTree(kv, '/q')).roots).toEqual(['other'])
    await kv.delete(keys.node('/p', 'r1'))
    expect((await loadTree(kv, '/p')).roots).toEqual(['c1'])
  })
})

describe('migrating the first M0 layout (one tree:<root> key)', () => {
  test('nodes, activeThread and tags move to their own keys; the old key goes', async () => {
    const kv = memKV()
    const old = (id: string, parentId: string | null, at: number) => ({
      ...n(id, A, at),
      parentId,
      outlineId: null,
      anchor: { sessionId: A, turnId: null, at, mainSnippet: '' }, // no messageId yet
      answer: 'a',
      title: id,
      summary: null,
      tags: [],
      promotedAt: null,
      promotedTo: null, // renamed promotedIn since
      children: parentId === null ? ['c1'] : [],
    })
    await kv.set('tree:C:\\Users\\me\\proj', {
      version: 2,
      nodes: { r1: old('r1', null, 1), c1: old('c1', 'r1', 2) },
      roots: ['r1'],
      outlines: {},
      activeThread: { [A]: 'r1' },
      tags: ['db'],
      mainDigest: null,
    })
    // the new key spells the same folder the way repo().root does
    expect(await migrateLegacy(kv, 'C:/Users/me/proj')).toBe(2)
    expect(await kv.get('tree:C:\\Users\\me\\proj')).toBeUndefined()
    const t = await loadTree(kv, 'C:/Users/me/proj')
    expect(t.roots).toEqual(['r1'])
    expect(t.nodes.r1?.children).toEqual(['c1'])
    expect(t.nodes.c1).toMatchObject({ promotedIn: null, anchor: { messageId: null } })
    expect('promotedTo' in t.nodes.c1!).toBe(false)
    expect(t.activeThread).toEqual({ [A]: 'r1' })
    expect(t.tags).toEqual(['db'])
    // running it again finds nothing
    expect(await migrateLegacy(kv, 'C:/Users/me/proj')).toBe(0)
  })

  test('normalizeRoot: one spelling for backslashes, trailing slashes and the drive letter', () => {
    expect(normalizeRoot('C:\\Users\\me\\proj\\')).toBe('c:/Users/me/proj')
    expect(normalizeRoot('c:/Users/me/proj')).toBe('c:/Users/me/proj')
    expect(normalizeRoot('/home/me/proj/')).toBe('/home/me/proj')
  })
})
