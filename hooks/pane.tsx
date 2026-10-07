// UI skeleton only (PLAN.md: align the look with the developer before filling it in).
// Pure views: register.ts reads the state and hands in the surface's element table
// and the press handlers; nothing here touches `$`.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { countNodes, visibleRoots } from './tree'

export const PANE_ID = 'sticky'
export const PANE_TITLE = 'Sticky Notes'
/** Button.hotkey takes one digit or lowercase letter only (PROBE.md P7). */
export const OPEN_HOTKEY = 's'

export type BandData = { tree: Tree | null; unread: number; pending: number; sessionId: string }

/** 正在追問：<title> lives in the band (PLAN.md: not $.prompt.suggest). */
export function activeTitle(tree: Tree | null, sessionId: string): string | null {
  const id = tree?.activeThread[sessionId] ?? null
  return id === null ? null : (tree?.nodes[id]?.title ?? null)
}

/** P9: an answer that did not come from the fork had no project context. */
export function contextMark(n: TreeNode): string {
  return n.answeredBy === 'claude-fork' || n.answer === '' ? '' : ' · 無專案脈絡'
}

/** AbovePrompt: one line, a count, what is being followed up, and an open button. */
export function bandView(els: ElementTable, d: BandData, onOpen: () => void): RenderElement {
  const { Box, Text, Button } = els
  const n = d.tree ? countNodes(d.tree) : 0
  const following = activeTitle(d.tree, d.sessionId)
  return (
    <Box>
      <Text dimColor>
        📌 Sticky Notes {n}
        {d.unread > 0 ? ` · ${d.unread} 新` : ''}
        {d.pending > 0 ? ` · ${d.pending} 回答中` : ''}
        {following !== null ? ` · 正在追問：${following}` : ''}{' '}
      </Text>
      <Button key="open" plain hotkey={OPEN_HOTKEY} label="開啟" onPress={onOpen} />
    </Box>
  )
}

export type PaneData = { tree: Tree | null; selectedId: string | null; sessionId: string }

export type PaneActions = { select(id: string | null): void }

/** Pane: root list (● = this session's activeThread, ↑ = promoted), the selected answer, 回到主線. */
export function paneView(els: ElementTable, d: PaneData, act: PaneActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const active = d.tree?.activeThread[d.sessionId] ?? null
  const roots = d.tree ? visibleRoots(d.tree) : []
  const selected = d.selectedId !== null ? d.tree?.nodes[d.selectedId] : undefined
  return (
    <Box flexDirection="column">
      <Text bold>Sticky Notes（骨架）</Text>
      {roots.length === 0 && <Text dimColor>還沒有便利貼。</Text>}
      {roots.map(r => (
        <Button
          key={`node:${r.id}`}
          plain
          label={`${r.id === active ? '●' : '○'} ${r.title}${r.promotedAt !== null ? ' ↑' : ''}${r.children.length ? ` (+${r.children.length})` : ''}`}
          onPress={() => act.select(r.id)}
        />
      ))}
      {selected && (
        <Box flexDirection="column">
          <Text bold>
            {selected.title}
            {contextMark(selected)}
          </Text>
          <Markdown text={selected.answer !== '' ? selected.answer : selected.promotedAt !== null ? '_在主線回答_' : '_回答中…_'} />
        </Box>
      )}
      <Button key="back" label="回到主線" onPress={() => act.select(null)} />
    </Box>
  )
}
