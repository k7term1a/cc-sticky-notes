// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand, SHORT_COMMAND, SHORT_COMMAND_SPEC } from './commands'
import { cardsView } from './cards'
import { GALLERY_ID, GALLERY_TITLE, galleryView } from './gallery'
import { change, explainDrop, prepare, readOptions, recordFeedback, routePrompt, startNote, type Options } from './notes'
import { PANE_ID, PANE_TITLE, paneView, statusLine } from './pane'
import type { Ports } from './ports'
import { describeKey, findKey, keyFiles, resolveKey } from './secrets'
import { setActive } from './tree'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const unreadAtom = atom({ plugin: 'cc-sticky-notes', key: 'unread' } as const, 0)
const pendingAtom = atom({ plugin: 'cc-sticky-notes', key: 'pending' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastTurnId' } as const, null)
const turnsAtSidebarAtom = atom({ plugin: 'cc-sticky-notes', key: 'turnsAtLastSidebar' } as const, 0)
const lastPromptAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastPromptUuid' } as const, null)
const lastSampleAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastSampleId' } as const, null)
const galleryEventAtom = atom({ plugin: 'cc-sticky-notes', key: 'galleryEvent' } as const, '')
const galleryModeAtom = atom({ plugin: 'cc-sticky-notes', key: 'galleryMode' } as const, '')
const gallerySelectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'gallerySelected' } as const, null)
const galleryEditingAtom = atom({ plugin: 'cc-sticky-notes', key: 'galleryEditing' } as const, null)

/**
 * TEMP /sn ui-gallery [c] (gallery.tsx, cards.tsx): the catalog, or the card prototype.
 * The same view again closes the pane; another switches it. Every other command passes.
 */
async function toggleGallery($: EngineInterface, args: string): Promise<boolean> {
  const m = /^ui-gallery(?:\s+(c))?$/.exec(args.trim())
  if (!m) return false
  const mode = m[1] ?? ''
  const isOpen = (await $.ui.panes()).some(pane => pane.id === GALLERY_ID)
  if (isOpen && (await read($, galleryModeAtom)) === mode) return (await $.ui.close({ id: GALLERY_ID }), true)
  await update($, galleryModeAtom, () => mode)
  await update($, gallerySelectedAtom, () => null)
  if (!isOpen) await $.ui.open({ id: GALLERY_ID, title: GALLERY_TITLE })
  return true
}

/** Key files to try after the environment (secrets.ts says which and why). */
async function keyFilesOf($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return keyFiles(home, $.plugin.root)
}

/**
 * The status line under the prompt (the developer's pick, PROBE.md「UI 能放在哪裡」 D):
 * "cc-sticky-note <the question this session follows up>". Redrawn whenever the tree
 * or the pending count changes.
 */
async function refreshStatus($: EngineInterface) {
  $.ui.status(statusLine(await read($, treeAtom), await $.session.id(), await read($, pendingAtom)))
}

function portsOf($: EngineInterface): Ports {
  const readText = (path: string) => $.fs.read(path) as Promise<string>
  return {
    sessionId: () => $.session.id(),
    // PLAN.md: one tree per repo, shared by its worktrees; the session root outside a repo.
    projectRoot: async () => (await $.session.repo())?.root ?? (await $.session.root()),
    turns: () => $.session.turns(),
    messages: async () => {
      const list = await $.session.messages()
      return Array.isArray(list) ? list : []
    },
    now: () => $.clock.now(),
    later: fn => void $.clock.after(0, fn),
    store: {
      get: key => $.store.get(key),
      set: (key, value) => $.store.set(key, value),
      delete: key => $.store.delete(key),
      keys: () => $.store.keys(),
    },
    fetch: (url, init) => $.http.fetch(url, init),
    fork: prompt => $.model.fork({ prompt }),
    complete: request => $.model.complete(request),
    keys: {
      typesafe: async () => resolveKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), await keyFilesOf($), readText),
      openai: async () => resolveKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), await keyFilesOf($), readText),
      report: async () => {
        const files = await keyFilesOf($)
        return [
          describeKey('TYPESAFE_API_KEY', await findKey('TYPESAFE_API_KEY', await $.env.get('TYPESAFE_API_KEY'), files, readText)),
          describeKey('OPENAI_API_KEY', await findKey('OPENAI_API_KEY', await $.env.get('OPENAI_API_KEY'), files, readText)),
          `key 檔查找順序：${files.join(' → ')}`,
        ]
      },
    },
    ui: {
      log: (text, to) => $.ui.log(text, { to: to ?? 'transcript' }),
      toast: text => $.ui.toast(text),
      ask: (question, options, header) => $.ui.ask(question, { options, header }),
      openPane: async () => {
        await update($, unreadAtom, () => 0)
        await $.ui.open({ id: PANE_ID, title: PANE_TITLE })
      },
      closePane: () => $.ui.close({ id: PANE_ID }),
      isPaneOpen: async () => (await $.ui.panes()).some(pane => pane.id === PANE_ID),
      status: text => $.ui.status(text),
    },
    state: {
      publishTree: async tree => {
        await update($, treeAtom, () => tree)
        await refreshStatus($)
      },
      lastTurnId: () => read($, lastTurnAtom),
      turnsAtLastSidebar: () => read($, turnsAtSidebarAtom),
      setTurnsAtLastSidebar: async n => void (await update($, turnsAtSidebarAtom, () => n)),
      addPending: async delta => {
        await update($, pendingAtom, n => Math.max(0, n + delta))
        await refreshStatus($)
      },
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
      lastPromptUuid: () => read($, lastPromptAtom),
      lastSampleId: () => read($, lastSampleAtom),
      setLastSampleId: async id => void (await update($, lastSampleAtom, () => id)),
      setSelected: async id => void (await update($, selectedAtom, () => id)),
    },
  }
}

/** Pane click: show it and make it this session's activeThread. 回到主線 passes null. */
async function selectNode($: EngineInterface, id: string | null) {
  const p = portsOf($)
  const sessionId = await p.sessionId()
  await update($, selectedAtom, () => id)
  await change(p, t => setActive(t, sessionId, id))
}

/** The pane's follow-up box: straight to a note under that node, no Jev (PLAN.md). */
async function followUp($: EngineInterface, opts: Options, parentId: string, question: string) {
  await startNote(portsOf($), opts, {
    question,
    attach: { kind: 'under', parentId },
    answerer: 'fork',
    route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
  })
}

// ---- TEMP probe, /sn probe … (REQUESTS.md R1, R2, R5): remote surfaces and outputs, selection,
// prompt.fill, session.send, the MCP tools. Logged to $.store `probe:log` while `probe:on`;
// read back from the store file. Remove after the probe. ----
const PROBE_ON = 'probe:on'
const PROBE_LOG = 'probe:log'
const PROBE_ROSTER = 'probe:roster'
const PROBE_TURN_LINE = 'probe:turnLine'
/** First ui.render of each surface × component this process saw (the log stays readable). */
const seenRenders = new Set<string>()

async function probeOn($: EngineInterface): Promise<boolean> {
  return (await $.store.get(PROBE_ON)) === true
}

async function probeLog($: EngineInterface, kind: string, data: Record<string, unknown> = {}) {
  if (!(await probeOn($))) return
  const list = ((await $.store.get(PROBE_LOG)) as unknown[] | undefined) ?? []
  list.push({ at: new Date().toISOString(), session: (await $.session.id()).slice(0, 8), surfaces: await $.session.surfaces(), kind, ...data })
  await $.store.set(PROBE_LOG, list.slice(-400) as never)
}

async function probeHello($: EngineInterface) {
  const roster = ((await $.store.get(PROBE_ROSTER)) as { id: string; root: string; at: number }[] | undefined) ?? []
  const id = await $.session.id()
  const me = { id, root: await $.session.root(), at: Date.now() }
  await $.store.set(PROBE_ROSTER, [...roster.filter(r => r.id !== id), me] as never)
}

/** `/sn probe <sub> [text]`; null when the args are not a probe command. */
async function probeCommand($: EngineInterface, args: string): Promise<{ text?: string } | null> {
  const m = /^probe(?:\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(args.trim())
  if (!m) return null
  const sub = m[1] ?? ''
  const rest = (m[2] ?? '').trim()
  if (sub === 'on') {
    await $.store.set(PROBE_ON, true)
    await $.store.set(PROBE_LOG, [] as never)
    seenRenders.clear()
    await probeHello($)
    await probeLog($, 'probe.on')
    return { text: '[probe] 開始記錄' }
  }
  await probeLog($, `command probe ${sub}`, { rest: rest.slice(0, 40) })
  switch (sub) {
    case 'off':
      await $.store.set(PROBE_ON, false)
      return { text: '[probe] 停止記錄' }
    case 'out':
      // the four ways a mod writes back: which reach a remote client?
      $.ui.log('[probe] ui.log 灰字')
      $.ui.toast('[probe] toast')
      await $.store.set(PROBE_TURN_LINE, true)
      return { text: '[probe] 指令輸出（下一個回答的下方還會多一行 turn.complete）' }
    case 'ask':
      void $.clock.after(0, async () => {
        try {
          const a = await $.ui.ask('[probe] 你在這台看得到這個對話框嗎？', ['看得到', '看不到'])
          await probeLog($, 'ask.answer', { answer: a })
        } catch (err) {
          await probeLog($, 'ask.rejected', { error: String(err).slice(0, 120) })
        }
      })
      return {}
    case 'sel': {
      const s = await $.ui.selection()
      await probeLog($, 'selection', { selection: s ? { text: s.text.slice(0, 120), requestId: s.requestId ?? null } : null })
      return { text: s ? `[probe] selection：「${s.text.slice(0, 60)}」 row=${s.requestId ?? '—'}` : '[probe] selection：undefined' }
    }
    case 'fill':
      // after the command's own row: the composer is the person's again
      void $.clock.after(300, async () => {
        const r = await $.prompt.fill({ text: rest || '[probe] prompt.fill 放進來的文字', mode: 'replace' })
        await probeLog($, 'prompt.fill', { result: r })
      })
      return {}
    case 'hello':
      await probeHello($)
      return { text: `[probe] 這個 session 已登記：${(await $.session.id()).slice(0, 8)}` }
    case 'send': {
      const roster = ((await $.store.get(PROBE_ROSTER)) as { id: string; root: string; at: number }[] | undefined) ?? []
      const me = await $.session.id()
      const other = roster.filter(r => r.id !== me).sort((a, b) => b.at - a.at)[0]
      if (!other) return { text: '[probe] 名單上沒有別的 session：先在另一個 session 打 /sn probe hello' }
      const r = await $.session.send({ to: { sessionId: other.id }, text: rest || '[probe] 從另一個 session 送來的文字' })
      await probeLog($, 'session.send', { to: other.id.slice(0, 8), root: other.root, result: r })
      return { text: `[probe] 送到 ${other.id.slice(0, 8)}（${other.root}）：${JSON.stringify(r)}` }
    }
    case 'tools': {
      const names = (await $.tool.list()).filter(t => t.mcp).map(t => t.name)
      const notion = names.filter(n => /notion/i.test(n))
      const drive = names.filter(n => /drive|google/i.test(n))
      await probeLog($, 'tools', { mcp: names.length, notion, drive })
      return { text: `[probe] MCP 工具 ${names.length} 個；Notion：${notion.slice(0, 8).join(', ') || '無'}；Drive：${drive.slice(0, 8).join(', ') || '無'}` }
    }
    case 'log': {
      const list = ((await $.store.get(PROBE_LOG)) as Record<string, unknown>[] | undefined) ?? []
      return { text: list.slice(-30).map(x => JSON.stringify(x)).join('\n') || '[probe] 沒有紀錄' }
    }
    default:
      return { text: '[probe] 子指令：on | off | out | ask | sel | fill [文字] | hello | send [文字] | tools | log' }
  }
}

/** A remote surface's draw: logged once per component; on AssistantMessage, a probe line beneath. */
async function probeRender($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], drawn: unknown) {
  const k = `${e.surface}:${e.component}`
  if (!seenRenders.has(k)) {
    seenRenders.add(k)
    await probeLog($, 'ui.render', { surface: e.surface, component: e.component })
  }
  if (e.component !== 'AssistantMessage' || !(await probeOn($))) return drawn
  const { Box, Text } = $.ui.resolve(e)
  return (
    <Box flexDirection="column">
      {drawn as never}
      <Text dimColor>{`[probe] mod 畫在 ${e.surface} 上的字`}</Text>
    </Box>
  )
}

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  // TEMP probe hooks (see probeCommand)
  on('session.attach', async ($, e, next) => {
    await probeLog($, 'session.attach', { surface: e.surface, clientId: e.clientId, viewport: e.viewport ?? null })
    return next(e)
  })
  on('session.detach', async ($, e, next) => {
    await probeLog($, 'session.detach', { surface: e.surface, clientId: e.clientId, reason: e.reason })
    return next(e)
  })
  on('session.receive', async ($, e, next) => {
    await probeLog($, 'session.receive', { origin: e.origin, text: e.text.slice(0, 80) })
    // R1 (a): a probe message from another session goes into the prompt box as a draft
    if (e.origin.kind === 'peer' && 'plugin' in e.origin && e.origin.plugin === 'cc-sticky-notes' && (await probeOn($))) {
      const text = e.text
      void $.clock.after(0, async () => {
        const r = await $.prompt.fill({ text, mode: 'replace' })
        await probeLog($, 'receive.fill', { result: r })
      })
      return { consumed: 'probe: put in the prompt box' }
    }
    return next(e)
  })
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId !== undefined || (await $.store.get(PROBE_TURN_LINE)) !== true) return r
    await $.store.set(PROBE_TURN_LINE, false)
    await probeLog($, 'turn.complete.line')
    return { ...r, text: '[probe] turn.complete 在回答下方多畫的一行' }
  })
  on('ui.render', { surface: 'mobile' }, async ($, e, next) => probeRender($, e, await next(e)) as never)
  on('ui.render', { surface: 'vscode' }, async ($, e, next) => probeRender($, e, await next(e)) as never)

  on('session.start', async ($, e, next) => {
    await $.command.register(COMMAND_SPEC)
    await $.command.register(SHORT_COMMAND_SPEC)
    await prepare(portsOf($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    return next(e)
  })

  on('session.append', async ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    // anchor.messageId: the main-line user message a later sidebar question sits after (M2 badge).
    if (e.door === 'prompt' && e.message.type === 'user' && !e.message.isMeta) {
      await update($, lastPromptAtom, () => e.uuid)
      return next(e)
    }
    // PROBE.md P10: `/sticky-note new <問題>` would leave the question in the main context.
    if (e.door === 'command') {
      let masked = false
      const content = e.message.content.map(block => {
        if (block.type !== 'text' || typeof block.text !== 'string') return block
        const text = maskNewArgs(block.text)
        if (text === null) return block
        masked = true
        return { ...block, text }
      })
      if (masked) return next({ ...e, message: { ...e.message, content } })
    }
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    await probeLog($, 'prompt.submit', { origin: e.origin.kind, text: e.text.slice(0, 40) }) // TEMP probe
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)

    const p = portsOf($)
    const routed = await routePrompt(p, opts, e.text, { remote: e.origin.kind === 'bridge' })
    const keep = (nodeId: string | null) => p.later(() => void recordFeedback(p, opts, e.text, routed, nodeId))
    const d = routed.decision
    switch (d.kind) {
      case 'main':
      case 'ask':
        keep(null)
        return next(e)
      case 'project_question':
        // the main line answers it; no note (going to the main line means no note)
        keep(null)
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        keep(
          await startNote(p, opts, {
            question: e.text,
            attach: d.parentId !== undefined ? { kind: 'under', parentId: d.parentId } : { kind: d.attach },
            answerer: d.answerer,
            route: d.route,
            tag: d.tag.kind === 'existing' ? d.tag.tag : undefined,
          }),
        )
        // The drop reason is the transparency line (PROBE.md P2): who decided, how sure, where it went.
        return { drop: explainDrop(e.text, routed) }
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => (await probeCommand($, e.args)) ?? ((await toggleGallery($, e.args)) ? {} : runCommand(portsOf($), opts, e.args)))
  // /sn: the keyboard shortcut for the pane (the status line cannot be clicked; PROBE.md)
  on('command.run', { command: SHORT_COMMAND }, async ($, e) => (await probeCommand($, e.args)) ?? ((await toggleGallery($, e.args)) ? {} : runCommand(portsOf($), opts, e.args)))

  // TEMP /sn ui-gallery
  on('ui.render', { component: 'Pane', requestId: GALLERY_ID }, async ($, e) => {
    const els = $.ui.resolve(e)
    const event = (what: string) => void update($, galleryEventAtom, () => what)
    const mode = await read($, galleryModeAtom)
    if (mode === '') return galleryView(els, await read($, galleryEventAtom), { event })
    const data = { tree: await read($, treeAtom), selectedId: await read($, gallerySelectedAtom), editingId: await read($, galleryEditingAtom), sessionId: await $.session.id(), pending: await read($, pendingAtom), surface: e.surface, lastPress: await read($, galleryEventAtom) }
    // TEMP: each press is stamped at the top, to tell a click that never arrived from one that drew late
    const stamp = (what: string) => {
      const d = new Date()
      const t = `${d.toTimeString().slice(0, 8)}.${String(d.getMilliseconds()).padStart(3, '0')}`
      void update($, galleryEventAtom, () => `${what} @ ${t}`)
    }
    const act = { select: (id: string | null) => (stamp(id === null ? '收合' : `展開 ${id.slice(0, 8)}`), void update($, gallerySelectedAtom, () => id)), edit: (id: string | null) => void update($, galleryEditingAtom, () => id), event: (what: string) => $.ui.toast(what) }
    return cardsView(els, data, act)
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = {
      tree: await read($, treeAtom),
      selectedId: await read($, selectedAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
    }
    return paneView($.ui.resolve(e), data, {
      select: id => void selectNode($, id),
      back: () => void selectNode($, null),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
    })
  })
}
