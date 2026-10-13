// UI: the band and the pane draw valid trees on terminal and desktop, follow-ups
// are listed under their parent, and a click shows the whole thread.
import { expect, mock, test } from 'claude-code/testing'

import type { TreeNode } from '../types'

const PLUGIN = 'cc-sticky-notes'
const ROOT = '/proj'

const node = (id: string, parentId: string | null, at: number, title: string, answer: string, summary: string | null = null): TreeNode => ({
  id,
  parentId,
  outlineId: null,
  anchor: { sessionId: 'S1', turnId: null, messageId: null, at, mainSnippet: '' },
  question: `${title}?`,
  answer,
  answeredBy: 'claude-fork',
  title,
  summary,
  tags: [],
  route: { label: 'sidebar_knowledge', confidence: 1, source: 'jev' },
  promotedAt: null,
  promotedIn: null,
  children: [],
})

const PANE = {
  component: 'Pane',
  requestId: 'sticky',
  props: { title: 'Sticky Notes', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { top: 0, bodyRows: 40, contentRows: 1 }, view: {} } as never,
} as const

test('empty: the pane validates on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    expect(await pane.find({ type: 'Text', text: /還沒有/ })).toBeDefined()
    await pane.unmount()
  }
})

test('a tree: follow-ups are listed under their parent and a click shows the thread', async ($, on) => {
  mock.store(on, {
    [`node:${ROOT}:r1`]: node('r1', null, 1, '樹載入原因', '因為 $.store 一次只讀一個 key。', '一次只能讀一個 key。'),
    [`node:${ROOT}:c1`]: node('c1', 'r1', 2, '為何全讀', '因為 roots 與 children 是推出來的。'),
    [`node:${ROOT}:r2`]: node('r2', null, 3, 'TCP 背壓', '接收窗口。'),
  })
  const clock = mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('session.turns', () => ({ value: 1 }))
  on('session.messages', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  let forked = ''
  const forks: string[] = []
  on('model.fork', ($, e) => {
    forked = e.prompt
    forks.push(e.prompt.slice(-30))
    return { value: { isAnswered: true, text: 'fork answer', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })
  on('model.complete', () => ({ value: { isAnswered: true, text: '{"title":"新追問","summary":"s"}', usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    const child = await pane.find({ key: 'node:c1' })
    expect(child).toBeDefined()
    expect(JSON.stringify(child)).toContain('└')
    expect(await pane.find({ key: 'node:r2' })).toBeDefined()

    await pane.press({ key: 'node:c1' })
    // the card: earlier step compact, the question, the full answer
    expect(await pane.find({ type: 'Text', text: /樹載入原因 — 一次只能讀一個 key/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /Q 為何全讀\?/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /追問第 2 層/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /在主輸入框直接打字＝追問「為何全讀」/ })).toBeDefined()
    await pane.unmount()
  }

  // the follow-up box: a child of the selected node, then that child is selected
  const pane = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE })
  await pane.input({ key: 'followup:c1', text: '那 children 什麼時候算？' })
  await clock.advance(10) // the answer runs in $.clock.after(0)
  // the new note is selected: its card shows its question
  expect(await pane.find({ type: 'Text', text: /Q 那 children 什麼時候算？/ })).toBeDefined()
  // the box is a new, empty one under the new note
  expect(await pane.find({ key: 'followup:c1' })).toBeUndefined()
  expect(JSON.stringify(await pane.find({ type: 'Input' }))).toContain('"value":""')
  await pane.unmount()
  await clock.advance(1000)
  expect(forks).toHaveLength(1)
  // the answer and its title arrived
  expect(await (async () => { const p = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', ...PANE }); const t = await p.find({ type: 'Text', text: /^新追問$/ }); await p.unmount(); return t })()).toBeDefined()
  expect(forked).toContain('[side thread so far]')
  expect(forked).toContain('Q2: 為何全讀?')
  expect(forked).toContain('[question]\n那 children 什麼時候算？')
})

test('/sn opens and closes the pane like /sticky-note', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  const open: string[] = []
  let isOpen = false
  on('ui.open', ($, e) => {
    open.push(e.id)
    isOpen = true
    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isOpen = false
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'sticky', title: 'Sticky Notes', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(open).toEqual(['sticky'])
  expect(isOpen).toBe(true)
  await $.command.run({ command: 'sn', args: '' } as never)
  expect(isOpen).toBe(false)
})

test('a pasted 12,000-character question and a 15,000-character answer still draw (Text / Markdown hold 10,000)', async ($, on) => {
  const longQ = '貼上的內容'.repeat(2400) // 12,000 characters
  const longA = '很長的答案。'.repeat(2500) // 15,000 characters
  mock.store(on, { [`node:${ROOT}:big`]: { ...node('big', null, 1, '長問題', longA), question: longQ } })
  mock.clock(on)
  on('session.id', () => ({ value: 'S1' }))
  on('session.root', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: null }))
  on('command.register', () => ({ value: { command: 'sticky-note' } }))
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE })
    await pane.press({ key: 'node:big' })
    expect(await pane.find({ type: 'Text', text: /（共 12000 字）/ })).toBeDefined()
    expect(await pane.find({ key: 'node:big' })).toBeDefined() // the engine did not draw its own instead
    await pane.unmount()
  }
})

test('TEMP /sn ui-gallery opens a pane that draws on terminal and desktop', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  const open: string[] = []
  on('ui.open', ($, e) => (open.push(e.id), { value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [] }) as never)
  await $.command.run({ command: 'sn', args: 'ui-gallery' } as never)
  expect(open).toEqual(['sticky-gallery'])
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE, requestId: 'sticky-gallery' })
    expect(await pane.find({ type: 'Text', text: /14\. 可用的符號/ })).toBeDefined()
    await pane.press({ key: 'g-btn-primary' })
    expect(await pane.find({ type: 'Text', text: /最後一個互動：Button primary/ })).toBeDefined()
    await pane.unmount()
  }
})

test('TEMP /sn ui-gallery a and b draw the two card plans over sample notes', async ($, on) => {
  mock.store(on)
  on('session.id', () => ({ value: 'S1' }))
  let isOpen = false
  on('ui.open', () => ((isOpen = true), { value: { isPlaced: true } }))
  on('ui.close', () => ((isOpen = false), { value: undefined }))
  on('ui.panes', () => ({ value: isOpen ? [{ id: 'sticky-gallery', title: 'UI Gallery', isShown: true, isFocused: false, isPlaced: true }] : [] }) as never)
  for (const [plan, title] of [['a', 'a-title:c1'], ['b', 'b-title:r1']] as const) {
    await $.command.run({ command: 'sn', args: `ui-gallery ${plan}` } as never)
    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: PLUGIN, surface, ...PANE, requestId: 'sticky-gallery' })
      expect(await pane.find({ type: 'Text', text: plan === 'a' ? /方案 A/ : /方案 B/ })).toBeDefined()
      await pane.press({ key: title })
      expect(await pane.find({ type: 'Button', label: '收合' } as never)).toBeDefined()
      await pane.press({ key: plan === 'a' ? 'a-close:c1' : 'b-close:r1' })
      await pane.unmount()
    }
  }
  await $.command.run({ command: 'sn', args: 'ui-gallery b' } as never)
  expect(isOpen).toBe(false)
})
