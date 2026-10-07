// Tree data model: pure operations on an in-memory Tree, plus the $.store layout.
//
// Layout (PLAN.md「資料模型」): one key per node, outline and session, so two
// sessions writing at once never overwrite each other (PROBE.md P3):
//   node:<root>:<id>  outline:<root>:<id>  active:<root>:<sessionId>  meta:<root>
// `roots` and every node's `children` are derived from parentId on load, never
// stored, so adding a child never rewrites its parent's key.
import type { Anchor, AnsweredBy, MainDigest, Outline, RouteSource, Tree, TreeMeta, TreeNode } from '../types'
import type { KV } from './ports'

export const TITLE_MAX = 12

export function emptyTree(): Tree {
  return { nodes: {}, roots: [], outlines: {}, activeThread: {}, tags: [], mainDigest: null }
}

/** The project key: repo root (shared across worktrees) or session root, without trailing separators. */
export function normalizeRoot(root: string): string {
  return root.replace(/[\\/]+$/, '')
}

export const keys = {
  node: (root: string, id: string) => `node:${root}:${id}`,
  outline: (root: string, id: string) => `outline:${root}:${id}`,
  active: (root: string, sessionId: string) => `active:${root}:${sessionId}`,
  meta: (root: string) => `meta:${root}`,
}

/** First TITLE_MAX characters (code points, so CJK and emoji are not split). */
export function fallbackTitle(question: string): string {
  return [...question.replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX).join('')
}

/** Recomputes roots and children from parentId; a node whose parent is gone counts as a root. */
export function derive(tree: Tree): Tree {
  const byAt = (a: TreeNode, b: TreeNode) => a.anchor.at - b.anchor.at || a.id.localeCompare(b.id)
  const all = Object.values(tree.nodes).sort(byAt)
  const children: Record<string, string[]> = {}
  const roots: string[] = []
  for (const n of all) {
    if (n.parentId !== null && tree.nodes[n.parentId]) (children[n.parentId] ??= []).push(n.id)
    else roots.push(n.id)
  }
  const nodes: Tree['nodes'] = {}
  for (const n of all) nodes[n.id] = { ...n, children: children[n.id] ?? [] }
  return { ...tree, nodes, roots }
}

export type NewNode = {
  id: string
  question: string
  anchor: Anchor
  route: { label: string; confidence: number; source: RouteSource }
  answeredBy: AnsweredBy
  answer?: string
  title?: string
  tags?: string[]
  /** Already promoted at creation (project_question bookmark). */
  promotedAt?: number | null
  promotedIn?: string | null
}

export type Attach =
  /** New root. */
  | { kind: 'root' }
  /** Under this session's activeThread; a root when it has none. */
  | { kind: 'followup' }
  /** Under an explicit parent (pane follow-up box). */
  | { kind: 'under'; parentId: string }

/**
 * Adds a node. By default it becomes this session's activeThread; a
 * project_question bookmark passes `makeActive: false`.
 * A follow-up whose parent is gone becomes a root rather than failing.
 */
export function addNode(
  tree: Tree,
  sessionId: string,
  input: NewNode,
  attach: Attach,
  opts: { makeActive?: boolean } = {},
): { tree: Tree; node: TreeNode } {
  if (tree.nodes[input.id]) throw new Error(`node ${input.id} already exists`)
  const wanted =
    attach.kind === 'under' ? attach.parentId : attach.kind === 'followup' ? (tree.activeThread[sessionId] ?? null) : null
  const parentId = wanted !== null && tree.nodes[wanted] ? wanted : null

  const node: TreeNode = {
    id: input.id,
    parentId,
    outlineId: null,
    anchor: input.anchor,
    question: input.question,
    answer: input.answer ?? '',
    answeredBy: input.answeredBy,
    title: input.title ?? fallbackTitle(input.question),
    summary: null,
    tags: input.tags ?? [],
    route: input.route,
    promotedAt: input.promotedAt ?? null,
    promotedIn: input.promotedIn ?? null,
    children: [],
  }

  const outlines = parentId === null ? tree.outlines : markStale(tree, rootOf(tree, parentId), input.anchor.at)
  const activeThread = opts.makeActive === false ? tree.activeThread : { ...tree.activeThread, [sessionId]: node.id }
  const next = derive({ ...tree, nodes: { ...tree.nodes, [node.id]: node }, outlines, activeThread })
  return { tree: next, node: next.nodes[node.id]! }
}

/** A new follow-up under an outline member makes that outline stale. */
function markStale(tree: Tree, rootId: string, at: number): Tree['outlines'] {
  const outlineId = tree.nodes[rootId]?.outlineId
  if (!outlineId) return tree.outlines
  const outline = tree.outlines[outlineId]
  if (!outline || outline.staleSince !== null) return tree.outlines
  return { ...tree.outlines, [outlineId]: { ...outline, staleSince: at } }
}

export function rootOf(tree: Tree, id: string): string {
  let cur = tree.nodes[id]
  if (!cur) throw new Error(`no node ${id}`)
  const seen = new Set<string>()
  while (cur.parentId !== null) {
    if (seen.has(cur.id)) throw new Error(`cycle at ${cur.id}`)
    seen.add(cur.id)
    const parent: TreeNode | undefined = tree.nodes[cur.parentId]
    if (!parent) break
    cur = parent
  }
  return cur.id
}

/** Root → … → id. */
export function pathTo(tree: Tree, id: string): TreeNode[] {
  const out: TreeNode[] = []
  let cur = tree.nodes[id]
  while (cur) {
    out.unshift(cur)
    cur = cur.parentId === null ? undefined : tree.nodes[cur.parentId]
  }
  return out
}

/** The Q/A chain a follow-up is asked over (answered nodes only). */
export function sideHistory(tree: Tree, id: string | null): { question: string; answer: string }[] {
  if (id === null || !tree.nodes[id]) return []
  return pathTo(tree, id)
    .filter(n => n.answer !== '')
    .map(n => ({ question: n.question, answer: n.answer }))
}

/** Pane click / "回到主線" (null). Unknown ids are ignored. */
export function setActive(tree: Tree, sessionId: string, id: string | null): Tree {
  if (id !== null && !tree.nodes[id]) return tree
  return { ...tree, activeThread: { ...tree.activeThread, [sessionId]: id } }
}

export type NodePatch = Partial<Pick<TreeNode, 'answer' | 'answeredBy' | 'title' | 'summary' | 'tags'>>

export function updateNode(tree: Tree, id: string, patch: NodePatch): Tree {
  const node = tree.nodes[id]
  if (!node) return tree
  const title = patch.title === undefined ? node.title : [...patch.title].slice(0, TITLE_MAX).join('') || node.title
  return { ...tree, nodes: { ...tree.nodes, [id]: { ...node, ...patch, title } } }
}

/** 回流主線: promotion only ever goes into the session it was pressed in. */
export function markPromoted(tree: Tree, id: string, sessionId: string, at: number): Tree {
  const node = tree.nodes[id]
  if (!node) return tree
  return { ...tree, nodes: { ...tree.nodes, [id]: { ...node, promotedAt: at, promotedIn: sessionId } } }
}

/** Removes a node and its whole subtree (重新分類 sends the question to the main line instead). */
export function removeNode(tree: Tree, id: string): Tree {
  const node = tree.nodes[id]
  if (!node) return tree
  const gone = new Set<string>()
  const walk = (nid: string) => {
    gone.add(nid)
    for (const c of tree.nodes[nid]?.children ?? []) walk(c)
  }
  walk(id)

  const nodes: Tree['nodes'] = {}
  for (const [k, v] of Object.entries(tree.nodes)) if (!gone.has(k)) nodes[k] = v

  const outlines: Tree['outlines'] = {}
  for (const [k, o] of Object.entries(tree.outlines)) {
    const memberIds = o.memberIds.filter(m => !gone.has(m))
    if (memberIds.length > 0) outlines[k] = { ...o, memberIds }
  }

  const activeThread: Tree['activeThread'] = {}
  for (const [s, a] of Object.entries(tree.activeThread)) activeThread[s] = a !== null && gone.has(a) ? node.parentId : a

  return derive({ ...tree, nodes, outlines, activeThread })
}

export type NewOutline = { id: string; title: string; outline: string; memberIds: string[]; createdAt: number }

/**
 * Groups roots under a new outline. Only roots may be members; a root already in
 * another outline is moved (returned in `moved` so the UI can say so), and an
 * outline left with no members is deleted.
 */
export function createOutline(tree: Tree, input: NewOutline): { tree: Tree; outline: Outline; moved: string[] } {
  const members = [...new Set(input.memberIds)]
  if (members.length === 0) throw new Error('an outline needs at least one root')
  if (tree.outlines[input.id]) throw new Error(`outline ${input.id} already exists`)
  for (const m of members) {
    if (tree.outlines[m]) throw new Error('an outline cannot be a member of an outline')
    const n = tree.nodes[m]
    if (!n) throw new Error(`no node ${m}`)
    if (n.parentId !== null) throw new Error(`node ${m} is not a root`)
  }

  const moved = members.filter(m => tree.nodes[m]!.outlineId !== null)
  const outlines: Tree['outlines'] = {}
  for (const [k, o] of Object.entries(tree.outlines)) {
    const memberIds = o.memberIds.filter(m => !members.includes(m))
    if (memberIds.length > 0) outlines[k] = { ...o, memberIds }
  }
  const outline: Outline = { ...input, memberIds: members, staleSince: null }
  outlines[outline.id] = outline

  const nodes = { ...tree.nodes }
  for (const m of members) nodes[m] = { ...nodes[m]!, outlineId: outline.id }
  return { tree: { ...tree, nodes, outlines }, outline, moved }
}

/** 重算: new outline text, clears the stale mark. */
export function refreshOutline(tree: Tree, id: string, outlineText: string): Tree {
  const o = tree.outlines[id]
  if (!o) return tree
  return { ...tree, outlines: { ...tree.outlines, [id]: { ...o, outline: outlineText, staleSince: null } } }
}

/** Deleting an outline breaks nothing: members just become ungrouped roots. */
export function deleteOutline(tree: Tree, id: string): Tree {
  const o = tree.outlines[id]
  if (!o) return tree
  const nodes = { ...tree.nodes }
  for (const m of o.memberIds) if (nodes[m]) nodes[m] = { ...nodes[m]!, outlineId: null }
  const outlines = { ...tree.outlines }
  delete outlines[id]
  return { ...tree, nodes, outlines }
}

export function addTag(tree: Tree, tag: string): Tree {
  const t = tag.trim()
  if (t === '' || tree.tags.includes(t)) return tree
  return { ...tree, tags: [...tree.tags, t] }
}

export function setMainDigest(tree: Tree, digest: MainDigest): Tree {
  return { ...tree, mainDigest: digest }
}

/** Roots for the pane, optionally only those asked in one session. */
export function visibleRoots(tree: Tree, onlySessionId?: string): TreeNode[] {
  return tree.roots
    .map(id => tree.nodes[id])
    .filter((n): n is TreeNode => n !== undefined)
    .filter(n => onlySessionId === undefined || n.anchor.sessionId === onlySessionId)
}

export function countNodes(tree: Tree): number {
  return Object.keys(tree.nodes).length
}

// ---- $.store layout ---------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object'

function readMeta(raw: unknown): TreeMeta {
  if (!isObj(raw) || raw.version !== 2) return { version: 2, tags: [], mainDigest: null }
  return {
    version: 2,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
    mainDigest: (raw.mainDigest as MainDigest | null | undefined) ?? null,
  }
}

/** Assembles one project's tree from its keys. */
export async function loadTree(store: KV, root: string): Promise<Tree> {
  const r = normalizeRoot(root)
  const all = await store.keys()
  const tree = emptyTree()
  const meta = readMeta(await store.get(keys.meta(r)))
  tree.tags = meta.tags
  tree.mainDigest = meta.mainDigest
  for (const key of all) {
    if (key.startsWith(keys.node(r, ''))) {
      const n = await store.get(key)
      if (isObj(n) && typeof n.id === 'string') tree.nodes[n.id] = { ...(n as TreeNode), children: [] }
    } else if (key.startsWith(keys.outline(r, ''))) {
      const o = await store.get(key)
      if (isObj(o) && typeof o.id === 'string') tree.outlines[o.id] = o as Outline
    } else if (key.startsWith(keys.active(r, ''))) {
      const a = await store.get(key)
      tree.activeThread[key.slice(keys.active(r, '').length)] = typeof a === 'string' ? a : null
    }
  }
  return derive(tree)
}

/** A node as stored: children are derived, so they are not kept. */
const stored = (n: TreeNode) => JSON.stringify({ ...n, children: [] })

/** Writes only the keys whose value changed between `before` and `after`; deletes the ones that went away. */
export async function saveDiff(store: KV, root: string, before: Tree, after: Tree): Promise<number> {
  const r = normalizeRoot(root)
  let writes = 0
  for (const [id, n] of Object.entries(after.nodes)) {
    const old = before.nodes[id]
    if (!old || stored(old) !== stored(n)) {
      await store.set(keys.node(r, id), { ...n, children: [] })
      writes++
    }
  }
  for (const id of Object.keys(before.nodes)) if (!after.nodes[id]) await store.delete(keys.node(r, id)), writes++
  for (const [id, o] of Object.entries(after.outlines)) {
    if (JSON.stringify(before.outlines[id]) !== JSON.stringify(o)) await store.set(keys.outline(r, id), o), writes++
  }
  for (const id of Object.keys(before.outlines)) if (!after.outlines[id]) await store.delete(keys.outline(r, id)), writes++
  for (const [sid, a] of Object.entries(after.activeThread)) {
    if (before.activeThread[sid] !== a) await store.set(keys.active(r, sid), a), writes++
  }
  if (JSON.stringify(before.tags) !== JSON.stringify(after.tags) || JSON.stringify(before.mainDigest) !== JSON.stringify(after.mainDigest)) {
    const meta: TreeMeta = { version: 2, tags: after.tags, mainDigest: after.mainDigest }
    await store.set(keys.meta(r), meta)
    writes++
  }
  return writes
}

/**
 * Load, apply, write back only what changed. Two sessions changing different
 * nodes never collide; only a simultaneous edit of the same node or outline
 * is last-writer-wins.
 */
export async function mutateTree(store: KV, root: string, fn: (tree: Tree) => Tree): Promise<Tree> {
  const before = await loadTree(store, root)
  const after = derive(fn(before))
  await saveDiff(store, root, before, after)
  return after
}
