// Pane and band views (M2 layout, first pass for review with the developer).
// Pure views: register.ts reads the state and hands in the surface's element table
// and the handlers; nothing here touches `$`.
//
//  Sticky Notes                            3 則 · 1 回答中
//  ╭ 便利貼 ───────────────────────────────────────────╮
//  │ ● 樹載入需多次讀取原因                              │
//  │   └ ● 為何需全讀節點                                │   ← ● = this session follows it up
//  │ ○ TCP backpressure ↑                               │   ← ↑ = promoted to the main line
//  ╰────────────────────────────────────────────────────╯
//  ╭ 為何需全讀節點 ────────────────────────────────────╮
//  │ 10/07 10:41 · Claude（看得到專案）· 追問第 2 層      │
//  │ 樹載入需多次讀取原因 — <summary of the earlier step> │   ← earlier steps, compact
//  │ Q 沒看懂，為什麼需要讀取全部的節點…                  │
//  │ <answer, Markdown>                                  │
//  │ [追問這一則…                         ] [送出]        │
//  │ [回到主線]                                          │
//  ╰────────────────────────────────────────────────────╯
//  在主輸入框直接打字＝追問「為何需全讀節點」
import type { ElementTable, RenderElement } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { countNodes, flatten, pathTo, visibleRoots } from './tree'

export const PANE_ID = 'sticky'
export const PANE_TITLE = 'Sticky Notes'

/** 正在追問：<title> lives in the band (PLAN.md: not $.prompt.suggest). */
export function activeTitle(tree: Tree | null, sessionId: string): string | null {
  const id = tree?.activeThread[sessionId] ?? null
  return id === null ? null : (tree?.nodes[id]?.title ?? null)
}

/**
 * The status line under the prompt (the developer's pick of the sites, no emoji):
 * "cc-sticky-note <the question this session follows up>", plain "cc-sticky-note"
 * when it follows none, "（回答中）" while answers are pending.
 */
export function statusLine(tree: Tree | null, sessionId: string, pending: number): string {
  const following = activeTitle(tree, sessionId)
  return (following === null ? 'cc-sticky-note' : `cc-sticky-note ${following}`) + (pending > 0 ? '（回答中）' : '')
}

/** P9: an answer that did not come from the fork had no project context. */
export function contextMark(n: TreeNode): string {
  return n.answeredBy === 'claude-fork' || n.answer === '' ? '' : ' · 無專案脈絡'
}

const ANSWERED_BY: Record<TreeNode['answeredBy'], string> = {
  'claude-fork': 'Claude（看得到專案）',
  claude: 'Claude',
  openai: 'OpenAI',
  manual: '手動',
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/** "10/07 10:41 · Claude（看得到專案）· 追問第 2 層" */
export function metaLine(n: TreeNode, depth: number): string {
  const d = new Date(n.anchor.at)
  const when = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  const by = n.promotedAt !== null && n.answer === '' ? '在主線回答' : ANSWERED_BY[n.answeredBy]
  return [when, by, depth > 0 ? `追問第 ${depth + 1} 層` : '旁支起點'].join(' · ') + contextMark(n)
}

const clip = (s: string, n: number) => {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}

export type PaneData = { tree: Tree | null; selectedId: string | null; sessionId: string; pending: number }

export type PaneActions = {
  select(id: string): void
  /** 回到主線: clears this session's activeThread and the selection. */
  back(): void
  /** The pane's follow-up box: a child of the selected node, not routed through Jev. */
  followUp(parentId: string, question: string): void
}

export function paneView(els: ElementTable, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  // mobile draws no Input (Elements): the follow-up box is left out there
  const Input = 'Input' in els ? els.Input : undefined
  const tree = d.tree
  const active = tree?.activeThread[d.sessionId] ?? null
  const rows = tree ? flatten(tree, visibleRoots(tree).map(r => r.id)) : []
  const selected = d.selectedId !== null ? tree?.nodes[d.selectedId] : undefined
  const path = selected && tree ? pathTo(tree, selected.id) : []
  const following = activeTitle(tree, d.sessionId)

  return (
    <Box flexDirection="column" gap={1}>
      <Box justifyContent="space-between">
        <Text bold>Sticky Notes</Text>
        <Text dimColor>
          {rows.length} 則{d.pending > 0 ? ` · ${d.pending} 回答中` : ''}
        </Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1}>
        <Text dimColor>便利貼</Text>
        {rows.length === 0 && <Text dimColor>還沒有。在主輸入框問「為什麼／是什麼」，或用 /sticky-note new。</Text>}
        {rows.map(({ node, depth }) => (
          <Button
            key={`node:${node.id}`}
            plain
            label={[
              '  '.repeat(depth),
              depth > 0 ? '└ ' : '',
              node.id === active ? '● ' : '○ ',
              node.title,
              node.answer === '' && node.promotedAt === null ? ' …' : '',
              node.promotedAt !== null ? ' ↑' : '',
              node.id === d.selectedId ? '  ◀' : '',
            ].join('')}
            onPress={() => act.select(node.id)}
          />
        ))}
      </Box>

      {selected && (
        <Box key="card" flexDirection="column" borderStyle="round" paddingX={1} gap={1}>
          <Box flexDirection="column">
            <Text bold>{selected.title}</Text>
            <Text dimColor>{metaLine(selected, path.length - 1)}</Text>
          </Box>
          {path.slice(0, -1).map(step => (
            <Text key={`step:${step.id}`} dimColor>
              {step.title} — {clip(step.summary ?? step.answer, 90)}
            </Text>
          ))}
          <Text bold>Q {selected.question}</Text>
          <Markdown
            text={selected.answer !== '' ? selected.answer : selected.promotedAt !== null ? '_這題在主線回答。_' : '_回答中…_'}
          />
          {Input && (
            <Input
              key="followup"
              placeholder="追問這一則…"
              submitLabel="送出"
              onSubmit={value => {
                if (value.trim() !== '') act.followUp(selected.id, value.trim())
              }}
            />
          )}
          <Box gap={1}>
            <Button key="back" label="回到主線" onPress={() => act.back()} />
          </Box>
        </Box>
      )}

      <Text dimColor>
        {following !== null ? `在主輸入框直接打字＝追問「${following}」；按「回到主線」結束追問。` : '點一則便利貼，接著在主輸入框打字就是追問它。'}
      </Text>
    </Box>
  )
}
