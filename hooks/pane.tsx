// UI skeleton only (PLAN.md: align the look with the developer before filling it in).
// Pure views: register.ts reads the state and hands in the surface's element table
// and the press handlers; nothing here touches `$`.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Tree } from '../types'
import { countNodes, visibleRoots } from './tree'

export const PANE_ID = 'sticky'
export const PANE_TITLE = 'Sticky Notes'

export type BandData = { tree: Tree | null; unread: number; pending: number }

/** AbovePrompt: one line, a count and an open button. */
export function bandView(els: ElementTable, d: BandData, onOpen: () => void): RenderElement {
  const { Box, Text, Button } = els
  const n = d.tree ? countNodes(d.tree) : 0
  return (
    <Box>
      <Text dimColor>
        📌 Sticky Notes {n}
        {d.unread > 0 ? ` · ${d.unread} 新` : ''}
        {d.pending > 0 ? ` · ${d.pending} 回答中` : ''}{' '}
      </Text>
      <Button key="open" plain label="開啟" onPress={onOpen} />
    </Box>
  )
}

export type PaneData = { tree: Tree | null; selectedId: string | null; sessionId: string }

export type PaneActions = { select(id: string | null): void }

/** Pane: root list (● = this session's activeThread), the selected answer, 回到主線. */
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
          label={`${r.id === active ? '●' : '○'} ${r.title}${r.children.length ? ` (+${r.children.length})` : ''}`}
          onPress={() => act.select(r.id)}
        />
      ))}
      {selected && (
        <Box flexDirection="column">
          <Text bold>{selected.title}</Text>
          <Markdown text={selected.answer === '' ? '_回答中…_' : selected.answer} />
        </Box>
      )}
      <Button key="back" label="回到主線" onPress={() => act.select(null)} />
    </Box>
  )
}
