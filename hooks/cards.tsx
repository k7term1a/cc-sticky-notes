// TEMP: two card layouts for the pane redesign, drawn in the ui-gallery pane
// (/sn ui-gallery a, /sn ui-gallery b) over the real tree, or sample notes when
// the project has none. Presses only move the prototype's own selection; the
// follow-up box records what was typed and asks nothing. Remove after the pick.
import type { ElementTable, RenderElement } from 'claude-code'

import type { Tree, TreeNode } from '../types'
import { derive, emptyTree, flatten, pathTo, rootOf } from './tree'

export type CardsData = { tree: Tree | null; selectedId: string | null; sessionId: string; pending: number }
export type CardsActions = { select(id: string | null): void; event(what: string): void }

const pad2 = (n: number) => String(n).padStart(2, '0')
const when = (at: number) => {
  const d = new Date(at)
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const clip = (s: string, n: number) => {
  const cps = [...s.replace(/\s+/g, ' ').trim()]
  return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('')
}
const by = (n: TreeNode) => (n.answeredBy === 'claude-fork' ? 'Claude（看得到專案）' : n.answeredBy === 'openai' ? 'OpenAI' : n.answeredBy === 'manual' ? '手動' : 'Claude')
const gist = (n: TreeNode) => (n.answer === '' ? '回答中…' : clip(n.summary ?? n.answer, 70))
const countAll = (tree: Tree, id: string): number => (tree.nodes[id]?.children ?? []).reduce((s, c) => s + 1 + countAll(tree, c), 0)

/** Sample notes for a project that has none yet. */
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
    c2: n('c2', 'c1', 9, 'children 何時算', '那 children 什麼時候算？', '每次 loadTree 之後呼叫 derive()，依 anchor.at 排序後重建。', '每次載入後 derive() 依時間重建。'),
    r2: n('r2', null, 20, 'TCP 背壓', 'TCP 的 backpressure 是什麼原理？', '接收端用接收窗口（rwnd）告訴送出端還能收多少；窗口變小，送出端就放慢。', '接收窗口變小時送出端放慢，避免緩衝區被塞爆。'),
    r3: n('r3', null, 31, 'CRDT 衝突合併', 'CRDT 怎麼做到不用協調就能合併？', '', ''),
  }
  t.activeThread = { sample: 'c1' }
  return derive(t)
}

function header(els: ElementTable, d: CardsData, tree: Tree, name: string): RenderElement {
  const { Box, Text } = els
  const total = Object.keys(tree.nodes).length
  return (
    <Box key="hdr" justifyContent="space-between">
      <Box columnGap={2}>
        <Text bold>Sticky Notes</Text>
        <Text dimColor>{name}</Text>
      </Box>
      <Text dimColor>{`${total} 張${d.pending > 0 ? ` · ${d.pending} 回答中` : ''}`}</Text>
    </Box>
  )
}

function followBox(els: ElementTable, id: string, act: CardsActions): RenderElement | null {
  const Input = 'Input' in els ? els.Input : undefined
  return Input ? (
    <Input key={`proto-follow:${id}`} value="" placeholder="追問這一張…" submitLabel="送出" onSubmit={v => act.event(`追問「${v}」（原型不會送出）`)} />
  ) : null
}

/**
 * Plan A — a wall of notes: every note is its own card; follow-ups are smaller
 * cards indented under their parent. A press opens the card in place.
 */
export function cardsA(els: ElementTable, d: CardsData, act: CardsActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const tree = d.tree && Object.keys(d.tree.nodes).length ? d.tree : sampleTree()
  const sessionId = d.tree && Object.keys(d.tree.nodes).length ? d.sessionId : 'sample'
  const active = tree.activeThread[sessionId] ?? null
  return (
    <Box flexDirection="column" gap={1}>
      {header(els, d, tree, '方案 A：每張便利貼一張卡')}
      {flatten(tree).map(({ node, depth }) => {
        const open = node.id === d.selectedId
        const kids = node.children.length
        return (
          <Box
            key={`a:${node.id}`}
            flexDirection="column"
            marginLeft={depth * 3}
            borderStyle="round"
            borderColor={open ? 'claude' : node.id === active ? 'success' : undefined}
            borderDimColor={!open && node.id !== active}
            hover={{ borderColor: 'claude', borderDimColor: false }}
            paddingX={1}
          >
            <Box justifyContent="space-between">
              <Button key={`a-title:${node.id}`} plain label={`${depth > 0 ? '↳ ' : ''}${node.title}`} onPress={() => act.select(open ? null : node.id)} />
              <Text dimColor>{when(node.anchor.at)}</Text>
            </Box>
            {!open && <Text dimColor>{gist(node)}</Text>}
            {!open && (kids > 0 || node.id === active) && (
              <Box columnGap={2}>
                {node.id === active && <Text color="success">● 追問中</Text>}
                {kids > 0 && <Text dimColor>{`${kids} 則追問`}</Text>}
              </Box>
            )}
            {open && (
              <Box flexDirection="column" gap={1} paddingY={1}>
                <Text dimColor>{`${by(node)} · ${depth > 0 ? `追問第 ${depth + 1} 層` : '旁支起點'}`}</Text>
                <Text bold>{`Q ${clip(node.question, 300)}`}</Text>
                <Markdown text={node.answer === '' ? '_回答中…_' : node.answer} />
                {followBox(els, node.id, act)}
                <Box gap={1}>
                  <Button key={`a-back:${node.id}`} label="回到主線" onPress={() => act.event('回到主線（原型）')} />
                  <Button key={`a-close:${node.id}`} label="收合" onPress={() => act.select(null)} />
                </Box>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

/**
 * Plan B — one card per topic: each root and all its follow-ups in one card.
 * Closed, a card is its title and a one-line gist; open, the thread reads top
 * to bottom as a conversation, with the follow-up box at its foot.
 */
export function cardsB(els: ElementTable, d: CardsData, act: CardsActions): RenderElement {
  const { Box, Text, Button, Markdown } = els
  const tree = d.tree && Object.keys(d.tree.nodes).length ? d.tree : sampleTree()
  const sessionId = d.tree && Object.keys(d.tree.nodes).length ? d.sessionId : 'sample'
  const active = tree.activeThread[sessionId] ?? null
  const openRoot = d.selectedId && tree.nodes[d.selectedId] ? rootOf(tree, d.selectedId) : null
  const activeRoot = active && tree.nodes[active] ? rootOf(tree, active) : null
  return (
    <Box flexDirection="column" gap={1}>
      {header(els, d, tree, '方案 B：每個主題一張卡')}
      {tree.roots.map(id => {
        const root = tree.nodes[id]!
        const open = id === openRoot
        const n = countAll(tree, id)
        const steps = flatten(tree, [id])
        const focus = open ? (tree.nodes[d.selectedId!] ?? root) : root
        const path = new Set(pathTo(tree, focus.id).map(s => s.id))
        return (
          <Box
            key={`b:${id}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={open ? 'claude' : id === activeRoot ? 'success' : undefined}
            borderDimColor={!open && id !== activeRoot}
            hover={{ borderColor: 'claude', borderDimColor: false }}
            paddingX={1}
          >
            <Box justifyContent="space-between">
              <Button key={`b-title:${id}`} plain label={root.title} onPress={() => act.select(open ? null : id)} />
              <Text dimColor>{`${n > 0 ? `${n + 1} 則 · ` : ''}${when(root.anchor.at)}`}</Text>
            </Box>
            {!open && <Text dimColor>{gist(root)}</Text>}
            {!open && id === activeRoot && <Text color="success">{`● 追問中：${tree.nodes[active!]?.title ?? ''}`}</Text>}
            {open && (
              <Box flexDirection="column" paddingY={1}>
                {steps.map(({ node, depth }) => {
                  const here = node.id === focus.id
                  const bar = depth > 0 ? '│ '.repeat(depth - 1) + '├ ' : ''
                  return (
                    <Box key={`b-step:${node.id}`} flexDirection="column" marginBottom={here ? 1 : 0}>
                      <Box>
                        <Text dimColor>{bar}</Text>
                        <Button key={`b-q:${node.id}`} plain dimColor={!path.has(node.id)} label={`Q ${clip(node.question, 60)}`} onPress={() => act.select(node.id)} />
                        {node.id === active && <Text color="success">{'  ●'}</Text>}
                      </Box>
                      {here ? (
                        <Box flexDirection="column" marginLeft={bar.length} borderStyle="single" borderDimColor paddingX={1}>
                          <Text dimColor>{`${by(node)} · ${when(node.anchor.at)}`}</Text>
                          <Markdown text={node.answer === '' ? '_回答中…_' : node.answer} />
                        </Box>
                      ) : (
                        path.has(node.id) && <Text dimColor>{`${' '.repeat(bar.length)}${gist(node)}`}</Text>
                      )}
                    </Box>
                  )
                })}
                {followBox(els, focus.id, act)}
                <Box gap={1} marginTop={1}>
                  <Button key={`b-back:${id}`} label="回到主線" onPress={() => act.event('回到主線（原型）')} />
                  <Button key={`b-close:${id}`} label="收合" onPress={() => act.select(null)} />
                </Box>
              </Box>
            )}
          </Box>
        )
      })}
    </Box>
  )
}
