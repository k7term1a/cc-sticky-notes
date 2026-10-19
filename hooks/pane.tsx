// The Sticky Notes pane: one card per topic (a root and all its follow-ups), the design
// the developer settled with the card prototype (PROBE.md〇之六). Pure view: register.tsx
// reads the state and hands in the surface's element table and the handlers.
//
//  Sticky Notes                                3 張 · 1 回答中
//  ╭──────────────────────────────────────────────────╮   closed: one line, one press
//  │ TCP 背壓　10/07 11:01                             │
//  ╰──────────────────────────────────────────────────╯
//  ╭──────────────────────────────────────────────────╮   open: the thread as a conversation,
//  │ 樹載入原因               [知識旁問] 10/07 10:41 · 3 │   no Q/A words — the question is a
//  │              ✎ ╭ 為什麼載入便利貼樹要讀… ╮       │   prompt bubble on the right (✎ under
//  │ <answer>                                         │   the pointer rewrites it), the answer
//  │ ● 為何全讀節點   ○ 存成一個 JSON                   │   under it; several follow-ups: pick
//  │              ✎ ╭ 沒看懂，為什麼需要讀取… ╮       │   which one the thread continues by
//  │ <answer>                                         │
//  │ [回覆…        ] [↵]                              │   the reply follows up the last answer
//  ╰──────────────────────────────────────────────────╯
// The card this session follows up has a green border; every other is plain gray.
import type { ElementTable, RenderElement, RenderSurface } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { ROUTE_NAME } from './route'
import { pathTo, rootOf } from './tree'

export const PANE_ID = 'sticky'
export const PANE_TITLE = 'Sticky Notes'
/** The selection that opens the project-context card (R4) instead of a topic. */
export const CONTEXT_CARD = '__context__'
/** The selection that opens the settings card (the mod's switches, 10/19). */
export const SETTINGS_CARD = '__settings__'

/** The switches the settings card shows, as this machine has them. */
export type Settings = {
  routing: boolean
  autoOpenPane: boolean
  notionSync: boolean
  /** A Notion data source is set (the sync switch means nothing without one). */
  notionSet: boolean
  digestEvery: number
  askTimeout: number
  provider: 'claude' | 'openai'
}
export type SettingField = 'routing' | 'autoOpenPane' | 'notionSync' | 'digestEvery' | 'askTimeout' | 'summaryProvider'

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
  /** R4: this session's main-line digest, the project facts, and how they are kept. */
  digest: string | null
  facts: readonly { id: string; text: string; source: 'auto' | 'manual' }[]
  digestEvery: number
  provider: 'claude' | 'openai'
  /** The last digest run of this session: running, or when it ended and how (in words). */
  digestStatus: { running: boolean; at: number | null; result: string | null }
  settings: Settings
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
  /** ✕: asks, then deletes this note and the follow-ups under it (this computer only). */
  remove(nodeId: string): void
  /** R4: the project context card's own edits, and a digest run now. */
  addFact(text: string): void
  removeFact(id: string): void
  refreshDigest(): void
  /** The settings card: one switch or choice, this machine's own, at once. */
  setSetting(field: SettingField, value: string | number | boolean): void
}

/** Choices a setting cycles through on each press (a Button is the one control every surface draws). */
const DIGEST_STEPS = [0, 1, 3, 5, 10]
const TIMEOUT_STEPS = [0, 15, 30, 60, 120]
const nextOf = (steps: readonly number[], now: number) => steps[(steps.indexOf(now) + 1) % steps.length] ?? steps[0]!

/**
 * The settings card, last in the pane: the mod's switches (what Desktop's own environment
 * panel cannot hold). Each row is a name and a press that flips or steps it.
 */
function settingsCard(els: ElementTable, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const s = d.settings
  const open = d.selectedId === SETTINGS_CARD
  if (!open) {
    return (
      <Box key="card:settings" borderStyle="round" borderDimColor paddingX={1}>
        <Button key="open:settings" plain dimColor label={`設定　${s.routing ? '自動判斷開' : '已暫停'}`} onPress={() => act.select(SETTINGS_CARD)} />
      </Box>
    )
  }
  const onOff = (v: boolean) => (v ? '● 開' : '○ 關')
  const row = (key: string, name: string, value: string, press: () => void, note?: string) => (
    <Box key={`set:${key}`} flexDirection="row" alignItems="center" columnGap={1}>
      <Box flexGrow={1} flexDirection="column">
        <Text>{name}</Text>
        {note !== undefined && <Text dimColor>{note}</Text>}
      </Box>
      <Button key={`set-btn:${key}`} label={value} onPress={press} />
    </Box>
  )
  return (
    <Box key="card:settings" flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
      <Button key="close:settings" plain label="設定" onPress={() => act.select(null)} />
      {row('routing', '自動判斷', onOff(s.routing), () => act.setSetting('routing', !s.routing), '關掉後每一句都直接進主線，不送 Jev、不跳對話框')}
      {row('timeout', '對話框逾時', s.askTimeout > 0 ? `${s.askTimeout} 秒` : '一直等', () => act.setSetting('askTimeout', nextOf(TIMEOUT_STEPS, s.askTimeout)))}
      {row('autoOpen', '答案回來時打開 pane', onOff(s.autoOpenPane), () => act.setSetting('autoOpenPane', !s.autoOpenPane))}
      {row('digest', '背景統整', s.digestEvery > 0 ? `每 ${s.digestEvery} 回合` : '關', () => act.setSetting('digestEvery', nextOf(DIGEST_STEPS, s.digestEvery)))}
      {row('provider', '統整層', s.provider === 'openai' ? 'OpenAI' : 'Claude', () => act.setSetting('summaryProvider', s.provider === 'openai' ? 'claude' : 'openai'))}
      {s.notionSet
        ? row('notion', 'Notion 同步', onOff(s.notionSync), () => act.setSetting('notionSync', !s.notionSync))
        : row('notion', 'Notion 同步', '未設定', () => {}, '用 /sn notion <collection://…> 設定資料庫')}
      <Text dimColor>只影響這台電腦；按鈕按一下就換到下一個值。</Text>
    </Box>
  )
}

/**
 * The card's category: what Jev called the first question (the developer, 10/14), in the
 * dialog's words. Translucent backgrounds, legible on the dark theme and the light one.
 */
export const CATEGORY: Record<string, { name: string; color: string }> = {
  sidebar_knowledge: { name: ROUTE_NAME.sidebar_knowledge, color: '#378ADD40' },
  project_question: { name: ROUTE_NAME.project_question, color: '#1D9E7540' },
  main_task: { name: ROUTE_NAME.main_task, color: '#BA751740' },
}

/** The category as a chip: its own background on Desktop; the terminal has no translucency, so it is dim. */
function categoryChip(els: ElementTable, surface: RenderSurface, key: string, jev: string | undefined): RenderElement | null {
  const { Text } = els
  const c = jev ? CATEGORY[jev] : undefined
  if (!c) return null
  return surface === 'terminal' ? (
    <Text key={key} dimColor>{`[${c.name}]`}</Text>
  ) : (
    <Text key={key} backgroundColor={c.color}>{` ${c.name} `}</Text>
  )
}

/**
 * The question drawn as the person's own prompt: Desktop's bubble look, on the right,
 * with ✎ (ask again) and ✕ (delete) beside it while the pointer is over the row (a Box cannot be pressed, and a
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
        <Button key={`remove:${node.id}`} plain dimColor label="✕" onPress={() => act.remove(node.id)} />
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

/**
 * R4: the project context card, last in the pane. Closed, one line; open, this session's
 * main-line digest, the facts (✕ deletes one), a box to add one, and a run now.
 */
function contextCard(els: ElementTable, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button } = els
  const Input = 'Input' in els ? els.Input : undefined
  const open = d.selectedId === CONTEXT_CARD
  const label = `專案脈絡　${d.facts.length} 條`
  if (!open) {
    return (
      <Box key="card:context" borderStyle="round" borderDimColor paddingX={1}>
        <Button key="open:context" plain dimColor label={label} onPress={() => act.select(CONTEXT_CARD)} />
      </Box>
    )
  }
  const how = d.digestEvery > 0 ? `每 ${d.digestEvery} 回合背景統整 · ${d.provider === 'openai' ? 'OpenAI' : 'Claude'}` : '背景統整已關閉（/sn every <n>）'
  return (
    <Box key="card:context" flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={1}>
      <Box justifyContent="space-between">
        <Button key="close:context" plain label="專案脈絡" onPress={() => act.select(null)} />
        <Text dimColor>{how}</Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>主線摘要（這個 session）</Text>
        <Text>{d.digest ?? '還沒有：主線跑過幾個回合後會出現。'}</Text>
      </Box>
      <Box flexDirection="column">
        <Text dimColor>專案脈絡（所有 session 共用；Jev 會看最新幾條）</Text>
        {d.facts.length === 0 && <Text dimColor>還沒有。背景統整會自動加，也可以在下面自己加。</Text>}
        {d.facts.map((f, i) => (
          <Box key={`fact:${f.id}`} flexDirection="row" columnGap={1}>
            <Text>{`${i + 1}. ${clip(f.text, 200)}${f.source === 'manual' ? '（手動）' : ''}`}</Text>
            <Button key={`fact-rm:${f.id}`} plain dimColor label="✕" onPress={() => act.removeFact(f.id)} />
          </Box>
        ))}
      </Box>
      {Input && (
        <Input
          key={`fact-add:${d.facts.length}`}
          value=""
          placeholder="加一條專案脈絡…"
          submitLabel="↵"
          onSubmit={v => {
            if (v.trim() !== '') act.addFact(v.trim())
          }}
        />
      )}
      <Box flexDirection="row" columnGap={2} alignItems="center">
        {d.digestStatus.running ? (
          <Text color="claude">統整中…</Text>
        ) : (
          <Button key="digest-now" plain dimColor label="立即統整" onPress={() => act.refreshDigest()} />
        )}
        {!d.digestStatus.running && d.digestStatus.at !== null && (
          <Text dimColor>{`上次 ${when(d.digestStatus.at).slice(6)}：${d.digestStatus.result ?? ''}`}</Text>
        )}
      </Box>
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
          const tag = categoryChip(els, d.surface, `category:${id}`, root.route.jev)

          if (!open) {
            // closed: one line. A Button holds one plain string (no colored part), so the tag is its
            // own chip between two presses that both open the card: the title, and the time
            return (
              <Box key={`card:${id}`} flexDirection="row" alignItems="center" columnGap={1} borderStyle="round" paddingX={1} {...frame}>
                <Box flexGrow={1}>
                  <Button key={`open:${id}`} plain label={`${root.title}${root.answer === '' && root.promotedAt === null ? ' …' : ''}`} onPress={() => act.select(id)} />
                </Box>
                {tag}
                <Button key={`open-meta:${id}`} plain dimColor label={meta} onPress={() => act.select(id)} />
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
              <Box flexDirection="row" alignItems="center" columnGap={1}>
                <Box flexGrow={1}>
                  <Button key={`close:${id}`} plain label={root.title} onPress={() => act.select(null)} />
                </Box>
                {tag}
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
            </Box>
          )
        })}

      {contextCard(els, d, act)}
      {settingsCard(els, d, act)}
    </Box>
  )
}
