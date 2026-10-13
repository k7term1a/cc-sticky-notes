// TEMP: the card layout for the pane redesign, drawn in the ui-gallery pane
// (/sn ui-gallery c) over the real tree, or sample notes when the project has
// none. Presses only move the prototype's own selection; the reply box records
// what was typed and asks nothing. Remove once the pane takes the design.
//
//  ╭────────────────────────────────────────╮   one card per topic (a root and its follow-ups)
//  │ 樹載入原因　10/07 10:41 · 3             │   closed: one line, the title and its time, one press
//  ╰────────────────────────────────────────╯
//  ╭────────────────────────────────────────╮   open: the thread as a conversation, no Q/A words —
//  │ 樹載入原因                  10/07 · 3   │   the question is a prompt bubble on the right,
//  │        ╭ 為什麼載入便利貼樹要讀… ╮      │   the answer plain under it
//  │ <answer>                                │
//  │ [為何全讀節點] [存成一個 JSON 不行嗎]   │   several follow-ups: pick which one continues
//  │        ╭ 沒看懂，為什麼需要讀取… ╮      │
//  │ <answer>                                │
//  │ [回覆…          ] [↵]                   │   the reply follows up the last answer shown
//  ╰────────────────────────────────────────╯
// The card this session follows up has a green border; every other is plain gray.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { derive, emptyTree, pathTo, rootOf } from './tree'

export type CardsData = {
  tree: Tree | null
  selectedId: string | null
  /** The question being rewritten in place, if any. */
  editingId: string | null
  sessionId: string
  pending: number
  surface: RenderSurface
}
export type CardsActions = { select(id: string | null): void; edit(id: string | null): void; event(what: string): void }

const pad2 = (n: number) => String(n).padStart(2, '0')
const when = (at: number) => {
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const clip = (s: string, n: number) => {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}
const countAll = (tree: Tree, id: string): number => (tree.nodes[id]?.children ?? []).reduce((s, c) => s + 1 + countAll(tree, c), 0)

/** Sample notes for a project that has none yet: one topic with two follow-ups, one plain, one still answering. */
export function sampleTree(): Tree {
  const base = Date.UTC(2026, 9, 7, 2, 41)
  const n = (id: string, parentId: string | null, min: number, title: string, question: string, answer: string, summary: string): TreeNode => ({
    id,
    parentId,
    outlineId: null,
    anchor: { sessionId: 'sample', turnId: null, messageId: null, at: base + min * 60000, mainSnippet: '' },
    question,
    answer,
    answeredBy: 'claude-fork',
    title,
    summary,
    tags: [],
    route: { label: 'new', confidence: 0.9, source: 'ask' },
    promotedAt: null,
    promotedIn: null,
    children: [],
  })
  const t = emptyTree()
  t.nodes = {
    r1: n('r1', null, 0, '樹載入原因', '為什麼載入便利貼樹要讀這麼多次 store？', '因為每個節點存成一個 key：`node:<root>:<id>`。\n\n- 同一個 key 的讀改寫是後寫贏\n- 拆開之後兩個 session 同時寫也不會互相蓋掉\n\n代價是載入時要列出所有 key 再逐一讀取。', '每個節點一個 key，避免兩個 session 互相蓋掉；代價是載入要逐一讀。'),
    c1: n('c1', 'r1', 4, '為何全讀節點', '沒看懂，為什麼需要讀取全部的節點？', 'roots 和 children 不存在 store 裡，是載入時從每個節點的 parentId 推出來的，所以要先拿到全部節點。', 'roots 與 children 是從 parentId 推出來的，必須先讀完全部節點。'),
    c2: n('c2', 'c1', 9, 'children 何時算', '那 children 什麼時候算？', '每次 loadTree 之後呼叫 `derive()`，依 anchor.at 排序後重建。', '每次載入後 derive() 依時間重建。'),
    c3: n('c3', 'r1', 12, '存成一個 JSON', '全部存成一個大 JSON 不行嗎？', '可以，但兩個 session 同時改就會後寫贏，另一邊的便利貼會不見。', '一個 key 會讓同時寫入互相蓋掉。'),
    r2: n('r2', null, 20, 'TCP 背壓', 'TCP 的 backpressure 是什麼原理？', '接收端用接收窗口（rwnd）告訴送出端還能收多少；窗口變小，送出端就放慢。', '接收窗口變小時送出端放慢，避免緩衝區被塞爆。'),
    r3: n('r3', null, 31, 'CRDT 衝突合併', 'CRDT 怎麼做到不用協調就能合併？', '', ''),
  }
  t.activeThread = { sample: 'c1' }
  return derive(t)
}

/**
 * The thread an open card reads: root → … → the picked note, then on down by the
 * newest follow-up (or the one this session follows up) until a note has none.
 */
export function threadOf(tree: Tree, pickedId: string, activeId: string | null): TreeNode[] {
  const path = pathTo(tree, pickedId)
  const onActive = activeId && tree.nodes[activeId] ? new Set(pathTo(tree, activeId).map(n => n.id)) : new Set<string>()
  let cur = path.at(-1)
  while (cur && cur.children.length > 0) {
    const next = cur.children.find(c => onActive.has(c)) ?? cur.children.at(-1)!
    cur = tree.nodes[next]
    if (cur) path.push(cur)
  }
  return path
}

/**
 * The question drawn as the person's own prompt: Desktop's bubble look, on the right,
 * with ✎ beside it while the pointer is over the row (a Box cannot be pressed, and a
 * Button draws one clipped line, so the bubble itself is not the press). The terminal
 * has no pointer to reveal it: there ✎ is always drawn.
 */
function bubble(els: ElementTable, surface: RenderSurface, node: TreeNode, act: CardsActions): RenderElement {
  const { Box, Text, Button } = els
  const look =
    surface === 'terminal'
      ? { borderStyle: 'round', borderDimColor: true }
      : // translucent gray: reads as the prompt bubble on the dark theme and on the light one
        { borderStyle: 'round', borderColor: '#80808040', backgroundColor: '#8080801f' }
  return (
    <Box key={`q:${node.id}`} alignSelf="flex-end" flexDirection="row" alignItems="center" columnGap={1} marginLeft={6} hover={{}}>
      <Box {...(surface === 'terminal' ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
        <Button key={`edit:${node.id}`} plain dimColor label="✎" onPress={() => act.edit(node.id)} />
      </Box>
      <Box paddingX={1} {...look}>
        <Text>{clip(node.question, 300)}</Text>
      </Box>
    </Box>
  )
}

/**
 * Rewriting a question asks it again beside the old one: a new follow-up of the same
 * parent (a new topic for a first question), so the parent's answer then offers both.
 */
function editor(els: ElementTable, node: TreeNode, tree: Tree, act: CardsActions): RenderElement | null {
  const { Box, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (!Input) return null
  const parent = node.parentId === null ? null : tree.nodes[node.parentId]
  return (
    <Box key={`editing:${node.id}`} flexDirection="column" alignItems="flex-end" gap={1}>
      <Input
        key={`edit-box:${node.id}`}
        value={node.question}
        submitLabel="↵"
        onSubmit={v => {
          act.edit(null)
          act.event(parent ? `在「${parent.title}」下多一個追問：「${v}」（原型不會送出）` : `開一張新的便利貼：「${v}」（原型不會送出）`)
        }}
      />
      <Button key={`edit-cancel:${node.id}`} plain dimColor label="取消" onPress={() => act.edit(null)} />
    </Box>
  )
}

export function cardsView(els: ElementTable, d: CardsData, act: CardsActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const Input = 'Input' in els ? els.Input : undefined
  const real = d.tree !== null && Object.keys(d.tree.nodes).length > 0
  const tree = real ? d.tree! : sampleTree()
  const active = tree.activeThread[real ? d.sessionId : 'sample'] ?? null
  const activeRoot = active && tree.nodes[active] ? rootOf(tree, active) : null
  const picked = d.selectedId && tree.nodes[d.selectedId] ? d.selectedId : null
  const openRoot = picked ? rootOf(tree, picked) : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>Sticky Notes</Text>
        <Text dimColor>{`${Object.keys(tree.nodes).length} 張${d.pending > 0 ? ` · ${d.pending} 回答中` : ''}`}</Text>
      </Box>

      {tree.roots.map(id => {
        const root = tree.nodes[id]!
        const open = id === openRoot
        const following = id === activeRoot
        const n = countAll(tree, id)
        const meta = `${when(root.anchor.at)}${n > 0 ? ` · ${n + 1}` : ''}`
        const frame = following ? { borderColor: 'success' } : { borderDimColor: true }

        if (!open) {
          return (
            <Box key={`card:${id}`} borderStyle="round" paddingX={1} {...frame}>
              {/* closed: the title and its time are one press (a Button holds one string, drawn on one
                  line: Desktop ignores a newline in it and clips what overflows) */}
              <Button key={`open:${id}`} plain label={`${root.title}　${meta}`} onPress={() => act.select(id)} />
            </Box>
          )
        }

        const thread = threadOf(tree, picked!, active)
        const last = thread.at(-1)!
        return (
          <Box key={`card:${id}`} flexDirection="column" borderStyle="round" paddingX={1} gap={1} {...frame}>
            <Box justifyContent="space-between">
              <Button key={`close:${id}`} plain label={root.title} onPress={() => act.select(null)} />
              <Text dimColor>{meta}</Text>
            </Box>
            {thread.map((node, i) => {
              const next = thread[i + 1]
              return (
                <Box key={`turn:${node.id}`} flexDirection="column" gap={1}>
                  {node.id === d.editingId ? editor(els, node, tree, act) : bubble(els, d.surface, node, act)}
                  <Markdown text={node.answer === '' ? '_回答中…_' : node.answer} />
                  {node.children.length > 1 && (
                    <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                      {node.children.map(c => (
                        <Button
                          key={`pick:${c}`}
                          plain
                          dimColor={c !== next?.id}
                          label={`${c === next?.id ? '● ' : '○ '}${tree.nodes[c]?.title ?? ''}`}
                          onPress={() => act.select(c)}
                        />
                      ))}
                    </Box>
                  )}
                </Box>
              )
            })}
            {Input && (
              // Desktop draws its native field at a fixed width whatever wraps it (PROBE.md〇之六); ↵ is Enter's label
              <Input key={`reply:${last.id}`} value="" placeholder="回覆…" submitLabel="↵" onSubmit={v => act.event(`回覆「${v}」接在「${last.title}」下（原型不會送出）`)} />
            )}
            {following && <Button key={`unfollow:${id}`} plain dimColor label="結束追問" onPress={() => act.event('結束追問（原型）')} />}
          </Box>
        )
      })}
    </Box>
  )
}
