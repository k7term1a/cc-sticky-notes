// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, maskNewArgs, runCommand } from './commands'
import { bookmarkNote, change, dropReason, prepare, readOptions, recordRoute, routePrompt, startNote, type Options } from './notes'
import { bandView, PANE_ID, PANE_TITLE, paneView } from './pane'
import { commandCard, label, replyFooter, userBadge } from './uidemo'
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
const uiDemoAtom = atom({ plugin: 'cc-sticky-notes', key: 'uiDemo' } as const, false)

/** Key files to try after the environment (secrets.ts says which and why). */
async function keyFilesOf($: EngineInterface): Promise<string[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  return keyFiles(home, $.plugin.root)
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
      publishTree: async tree => void (await update($, treeAtom, () => tree)),
      lastTurnId: () => read($, lastTurnAtom),
      turnsAtLastSidebar: () => read($, turnsAtSidebarAtom),
      setTurnsAtLastSidebar: async n => void (await update($, turnsAtSidebarAtom, () => n)),
      addPending: async delta => void (await update($, pendingAtom, n => Math.max(0, n + delta))),
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
      lastPromptUuid: () => read($, lastPromptAtom),
      lastSampleId: () => read($, lastSampleAtom),
      setLastSampleId: async id => void (await update($, lastSampleAtom, () => id)),
      setSelected: async id => void (await update($, selectedAtom, () => id)),
      toggleUiDemo: async () => {
        await update($, uiDemoAtom, on => !on)
        return read($, uiDemoAtom)
      },
    },
  }
}

/** Pane click: show it and make it this session's activeThread; the band shows 正在追問. 回到主線 passes null. */
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

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register(COMMAND_SPEC)
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
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)

    const p = portsOf($)
    const routed = await routePrompt(p, opts, e.text)
    const keep = (nodeId: string | null) => p.later(() => void recordRoute(p, opts, e.text, routed, nodeId))
    const d = routed.decision
    switch (d.kind) {
      case 'main':
      case 'ask':
        keep(null)
        return next(e)
      case 'project_question':
        keep(await bookmarkNote(p, e.text, d.route))
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        keep(
          await startNote(p, opts, {
            question: e.text,
            attach: { kind: d.attach },
            answerer: d.answerer,
            route: d.route,
            tag: d.tag.kind === 'existing' ? d.tag.tag : undefined,
          }),
        )
        // The drop reason is the transparency line (PROBE.md P2): no separate $.ui.log.
        return { drop: dropReason(e.text) }
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))

  // ---- /sticky-note ui-demo: label every place the mod can draw (uidemo.tsx) ----
  // B / C: the first try rewrote props (modes / hint) and the desktop drew nothing new;
  // this round draws the plugin's own tree there instead (B2 / C2).
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    if (!(await read($, uiDemoAtom))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text dimColor>{e.props.modes.join(' & ')}</Text>
        <Text>{label('B2')}📌 2</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    if (!(await read($, uiDemoAtom))) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box gap={1}>
        <Text>{label('C2')}📌 Sticky Notes</Text>
        <Text dimColor>{e.props.hint}</Text>
      </Box>
    )
  })
  on('ui.render', { component: 'Spinner' }, async ($, e, next) =>
    (await read($, uiDemoAtom)) ? next({ ...e, props: { ...e.props, word: `${label('E')}${e.props.word}` } }) : next(e),
  )
  // No isExpanded check here: the desktop has no ctrl+o, so its rows always read
  // as expanded, and skipping those drew nothing there (F missing on the desktop).
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await read($, uiDemoAtom))) return next(e)
    return userBadge($.ui.resolve(e), await next(e))
  })
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.isFirstOfReply || !(await read($, uiDemoAtom))) return next(e)
    return replyFooter($.ui.resolve(e), await next(e))
  })
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== COMMAND || e.props.args.trim() !== 'ui-demo' || !(await read($, uiDemoAtom))) return next(e)
    return commandCard($.ui.resolve(e))
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = {
      tree: await read($, treeAtom),
      unread: await read($, unreadAtom),
      pending: await read($, pendingAtom),
      sessionId: await $.session.id(),
    }
    const els = $.ui.resolve(e)
    const band = bandView(els, data, () => void portsOf($).ui.openPane())
    if (!(await read($, uiDemoAtom))) return band
    const { Box, Text } = els
    return (
      <Box>
        <Text>{label('A')}</Text>
        {band}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = {
      tree: await read($, treeAtom),
      selectedId: await read($, selectedAtom),
      sessionId: await $.session.id(),
      pending: await read($, pendingAtom),
    }
    const els = $.ui.resolve(e)
    const pane = paneView(els, data, {
      select: id => void selectNode($, id),
      back: () => void selectNode($, null),
      followUp: (parentId, question) => void followUp($, opts, parentId, question),
    })
    if (!(await read($, uiDemoAtom))) return pane
    const { Box, Text } = els
    return (
      <Box flexDirection="column">
        <Text>{label('I')} 右側 pane</Text>
        {pane}
      </Box>
    )
  })
}
