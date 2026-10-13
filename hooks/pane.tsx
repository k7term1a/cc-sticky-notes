// The Sticky Notes pane: one card per topic (a root and all its follow-ups), the design
// the developer settled with the card prototype (PROBE.md〇之六). Pure view: register.tsx
// reads the state and hands in the surface's element table and the handlers.
//
//  Sticky Notes                                3 張 · 1 回答中
//  ╭──────────────────────────────────────────────────╮   closed: one line, one press
//  │ TCP 背壓　10/07 11:01                             │
//  ╰──────────────────────────────────────────────────╯
//  ╭──────────────────────────────────────────────────╮   open: the thread as a conversation,
//  │ 樹載入原因                          10/07 10:41 · 3 │   no Q/A words — the question is a
//  │              ✎ ╭ 為什麼載入便利貼樹要讀… ╮       │   prompt bubble on the right (✎ under
//  │ <answer>                                         │   the pointer rewrites it), the answer
//  │ ● 為何全讀節點   ○ 存成一個 JSON                   │   under it; several follow-ups: pick
//  │              ✎ ╭ 沒看懂，為什麼需要讀取… ╮       │   which one the thread continues by
//  │ <answer>                                         │
//  │ [回覆…        ] [↵]                              │   the reply follows up the last answer
//  │ 結束追問                                          │   on the card this session follows up
//  ╰──────────────────────────────────────────────────╯
// The card this session follows up has a green border; every other is plain gray.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { pathTo, rootOf } from './tree'

export const PANE_ID = 'sticky'
export const PANE_TITLE = 'Sticky Notes'

/** P9: an answer that did not come from the fork had no project context. */
export function contextMark(n: TreeNode): string {
  return n.answeredBy === 'claude-fork' || n.answer === '' ? '' : '無專案脈絡'
}

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

/**
 * A Text or Markdown holds at most 10000 characters, or the whole pane is refused
 * and the engine draws its own (seen with an 11,810-character pasted question).
 */
export const QUESTION_SHOWN = 300
export const ANSWER_SHOWN = 9000
/**
 * One drawing holds 100,000 characters in all: an open thread draws its answers whole
 * from the newest back while this many remain, and the older ones as their summary.
 */
export const THREAD_BUDGET = 60000

/** The question as the bubble shows it: one line, its first 300 characters, and the full length when cut. */
export function shownQuestion(q: string): string {
  const n = [...q].length
  return n > QUESTION_SHOWN ? `${clip(q, QUESTION_SHOWN)}（共 ${n} 字）` : clip(q, QUESTION_SHOWN)
}

/** The answer as the card shows it: whole up to 9000 characters, newlines kept. */
export function shownAnswer(a: string): string {
  const cps = [...a]
  return cps.length > ANSWER_SHOWN ? `${cps.slice(0, ANSWER_SHOWN).join('')}\n\n_（答案共 ${cps.length} 字，只顯示前 ${ANSWER_SHOWN} 字）_` : a
}

/** What a turn's answer area says: the answer, or why there is none yet. */
function answerText(n: TreeNode, whole: boolean): string {
  if (n.answer === '') return n.promotedAt !== null ? '_這題在主線回答。_' : '_回答中…_'
  return whole ? shownAnswer(n.answer) : `${clip(n.summary ?? n.answer, 200)}　_（較早的回答只顯示摘要）_`
}

/**
 * The thread an open card reads: root → … → the picked note, then on down by the
 * follow-up this session follows up, else the newest, until a note has none.
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

export type PaneData = {
  tree: Tree | null
  /** The note whose card is open (its thread runs through it); null, every card closed. */
  selectedId: string | null
  /** The question being rewritten in place, if any. */
  editingId: string | null
  sessionId: string
  pending: number
  surface: RenderSurface
}

export type PaneActions = {
  /** Opens the card holding this note, its thread running through it; null closes. */
  select(id: string | null): void
  /** Starts (an id) or ends (null) rewriting a question in place. */
  edit(id: string | null): void
  /** The reply box: a follow-up under this note, not routed through Jev. */
  followUp(parentId: string, question: string): void
  /** A rewritten question: asked again beside the old one (a new topic for a first question). */
  rewrite(nodeId: string, question: string): void
  /** 結束追問: this session follows up no note any more. */
  unfollow(): void
}

/**
 * The question drawn as the person's own prompt: Desktop's bubble look, on the right,
 * with ✎ beside it while the pointer is over the row (a Box cannot be pressed, and a
 * Button draws one clipped line, so the bubble itself is not the press). The terminal
 * has no pointer to reveal it: there ✎ is always drawn.
 */
function bubble(els: ElementTable, surface: RenderSurface, node: TreeNode, act: PaneActions): RenderElement {
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
        <Text>{shownQuestion(node.question)}</Text>
      </Box>
    </Box>
  )
}

/** ✎: the question in a field, to be asked again beside the old one. */
function editor(els: ElementTable, node: TreeNode, act: PaneActions): RenderElement | null {
  const { Box, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  if (!Input) return null
  return (
    <Box key={`editing:${node.id}`} flexDirection="column" alignItems="flex-end" gap={1}>
      <Input
        key={`edit-box:${node.id}`}
        value={node.question}
        submitLabel="↵"
        onSubmit={v => {
          act.edit(null)
          if (v.trim() !== '' && v.trim() !== node.question.trim()) act.rewrite(node.id, v.trim())
        }}
      />
      <Button key={`edit-cancel:${node.id}`} plain dimColor label="取消" onPress={() => act.edit(null)} />
    </Box>
  )
}

export function paneView(els: ElementTable, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  // mobile draws no Input (Elements): the reply box is left out there
  const Input = 'Input' in els ? els.Input : undefined
  const tree = d.tree
  const nodes = tree ? Object.keys(tree.nodes).length : 0
  const active = tree?.activeThread[d.sessionId] ?? null
  const activeRoot = tree && active && tree.nodes[active] ? rootOf(tree, active) : null
  const picked = tree && d.selectedId && tree.nodes[d.selectedId] ? d.selectedId : null
  const openRoot = tree && picked ? rootOf(tree, picked) : null

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>Sticky Notes</Text>
        <Text dimColor>{`${nodes} 張${d.pending > 0 ? ` · ${d.pending} 回答中` : ''}`}</Text>
      </Box>

      {(tree === null || tree.roots.length === 0) && (
        <Text dimColor>還沒有便利貼。在主輸入框問「為什麼／是什麼」，或用 /sn new &lt;問題&gt;。</Text>
      )}

      {/* newest topic first */}
      {tree &&
        [...tree.roots].reverse().map(id => {
          const root = tree.nodes[id]!
          const open = id === openRoot
          const following = id === activeRoot
          const n = countAll(tree, id)
          const meta = `${when(root.anchor.at)}${n > 0 ? ` · ${n + 1}` : ''}`
          const frame = following ? { borderColor: 'success' } : { borderDimColor: true }

          if (!open) {
            return (
              <Box key={`card:${id}`} borderStyle="round" paddingX={1} {...frame}>
                {/* closed: the title and its time are one press (a Button holds one string, drawn on
                    one line: Desktop ignores a newline in it and clips what overflows) */}
                <Button key={`open:${id}`} plain label={`${root.title}${root.answer === '' && root.promotedAt === null ? ' …' : ''}　${meta}`} onPress={() => act.select(id)} />
              </Box>
            )
          }

          const thread = threadOf(tree, picked!, active)
          const last = thread.at(-1)!
          // answers drawn whole from the newest back while the budget lasts (THREAD_BUDGET)
          let budget = THREAD_BUDGET
          const whole = new Set<string>()
          for (const t of [...thread].reverse()) {
            const size = Math.min([...t.answer].length, ANSWER_SHOWN) + Math.min([...t.question].length, QUESTION_SHOWN)
            if (size > budget && whole.size > 0) break
            budget -= size
            whole.add(t.id)
          }
          return (
            <Box key={`card:${id}`} flexDirection="column" borderStyle="round" paddingX={1} gap={1} {...frame}>
              <Box justifyContent="space-between">
                <Button key={`close:${id}`} plain label={root.title} onPress={() => act.select(null)} />
                <Text dimColor>{meta}</Text>
              </Box>
              {thread.map((node, i) => {
                const next = thread[i + 1]
                const mark = contextMark(node)
                return (
                  <Box key={`turn:${node.id}`} flexDirection="column" gap={1}>
                    {node.id === d.editingId ? editor(els, node, act) : bubble(els, d.surface, node, act)}
                    <Markdown text={answerText(node, whole.has(node.id))} />
                    {mark !== '' && <Text dimColor>{mark}</Text>}
                    {node.children.length > 1 && (
                      // its own block (the developer, 10/14): native buttons in a dim frame, apart from the answer
                      <Box key={`picks:${node.id}`} flexDirection="row" flexWrap="wrap" alignItems="center" gap={1} borderStyle="round" borderDimColor paddingX={1}>
                        <Text dimColor>追問</Text>
                        {node.children.map(c => (
                          <Button
                            key={`pick:${c}`}
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
                // keyed by the note it follows up: a sent reply selects its new note, so the box is a
                // fresh, empty one; Desktop draws its native field at a fixed width (PROBE.md〇之六)
                <Input
                  key={`reply:${last.id}`}
                  value=""
                  placeholder="回覆…"
                  submitLabel="↵"
                  onSubmit={v => {
                    if (v.trim() !== '') act.followUp(last.id, v.trim())
                  }}
                />
              )}
              {following && <Button key={`unfollow:${id}`} plain dimColor label="結束追問" onPress={() => act.unfollow()} />}
            </Box>
          )
        })}
    </Box>
  )
}
