// Tree data model: pure operations on a Tree value, plus the $.store adapter.
// Pure functions never mutate their input; each returns a new Tree.
import type { Anchor, AnsweredBy, MainDigest, Outline, RouteSource, Tree, TreeNode } from '../types'
import type { KV } from './ports'

export const TITLE_MAX = 12

export function emptyTree(): Tree {
  return { version: 2, nodes: {}, roots: [], outlines: {}, activeThread: {}, tags: [], mainDigest: null }
}

/** $.store key; one tree per project, shared by all of its sessions. */
export function treeKey(projectRoot: string): string {
  return `tree:${projectRoot.replace(/[\\/]+$/, '')}`
}

/** Accepts whatever the store held (undefined, an older shape) and returns a usable Tree. */
export function normalizeTree(raw: unknown): Tree {
  if (raw === null || typeof raw !== 'object') return emptyTree()
  const t = raw as Partial<Tree>
  if (t.version !== 2) return emptyTree()
  return {
    version: 2,
    nodes: t.nodes ?? {},
    roots: t.roots ?? [],
    outlines: t.outlines ?? {},
    activeThread: t.activeThread ?? {},
    tags: t.tags ?? [],
    mainDigest: t.mainDigest ?? null,
  }
}

/** First TITLE_MAX characters (code points, so CJK and emoji are not split). */
export function fallbackTitle(question: string): string {
  return [...question.replace(/\s+/g, ' ').trim()].slice(0, TITLE_MAX).join('')
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
  promotedTo?: string | null
}

export type Attach =
  /** New root. */
  | { kind: 'root' }
  /** Under this session's activeThread; a root when it has none. */
  | { kind: 'followup' }
  /** Under an explicit parent (pane follow-up box). */
  | { kind: 'under'; parentId: string }

/**
 * Adds a node and makes it this session's activeThread.
 * A follow-up whose parent is gone becomes a root rather than failing.
 */
export function addNode(tree: Tree, sessionId: string, input: NewNode, attach: Attach): { tree: Tree; node: TreeNode } {
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
    promotedTo: input.promotedTo ?? null,
    children: [],
  }

  const nodes = { ...tree.nodes, [node.id]: node }
  let roots = tree.roots
  let outlines = tree.outlines
  if (parentId === null) {
    roots = [...roots, node.id]
  } else {
    const parent = tree.nodes[parentId]!
    nodes[parentId] = { ...parent, children: [...parent.children, node.id] }
    outlines = markStale(tree, rootOf(tree, parentId), input.anchor.at)
  }

  const next: Tree = { ...tree, nodes, roots, outlines, activeThread: { ...tree.activeThread, [sessionId]: node.id } }
  return { tree: next, node }
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

export function markPromoted(tree: Tree, id: string, to: string, at: number): Tree {
  const node = tree.nodes[id]
  if (!node) return tree
  return { ...tree, nodes: { ...tree.nodes, [id]: { ...node, promotedAt: at, promotedTo: to } } }
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
  if (node.parentId !== null && nodes[node.parentId]) {
    const parent = nodes[node.parentId]!
    nodes[node.parentId] = { ...parent, children: parent.children.filter(c => c !== id) }
  }

  const outlines: Tree['outlines'] = {}
  for (const [k, o] of Object.entries(tree.outlines)) {
    const memberIds = o.memberIds.filter(m => !gone.has(m))
    if (memberIds.length > 0) outlines[k] = { ...o, memberIds }
  }

  const activeThread: Tree['activeThread'] = {}
  for (const [s, a] of Object.entries(tree.activeThread)) activeThread[s] = a !== null && gone.has(a) ? node.parentId : a

  return { ...tree, nodes, roots: tree.roots.filter(r => !gone.has(r)), outlines, activeThread }
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

// ---- $.store adapter -------------------------------------------------------

export async function loadTree(store: KV, key: string): Promise<Tree> {
  return normalizeTree(await store.get(key))
}

/**
 * Read-modify-write with the read taken right before the write, so another
 * session's write in between is lost only inside that short window.
 * See PROBE.md: $.store has no compare-and-set; same-key writes from two
 * sessions are last-writer-wins.
 */
export async function mutateTree(store: KV, key: string, fn: (tree: Tree) => Tree): Promise<Tree> {
  const next = fn(await loadTree(store, key))
  await store.set(key, next)
  return next
}
