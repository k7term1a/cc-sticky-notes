// Entry point: the hooks, and portsOf — the one place `$` is turned into the
// closures the logic modules use (ports.ts says why `$` itself cannot cross).
import type { EngineInterface, Register } from 'claude-code'
import { atom, read, update } from 'claude-code'

import { COMMAND, COMMAND_SPEC, runCommand } from './commands'
import { change, dropReason, readOptions, refresh, routePrompt, startNote } from './notes'
import { bandView, PANE_ID, PANE_TITLE, paneView } from './pane'
import type { Ports } from './ports'
import { setActive } from './tree'

// $.state values (types/index.d.ts). The loader reads atoms only from this file's own consts.
const treeAtom = atom({ plugin: 'cc-sticky-notes', key: 'tree' } as const, null)
const selectedAtom = atom({ plugin: 'cc-sticky-notes', key: 'selectedId' } as const, null)
const unreadAtom = atom({ plugin: 'cc-sticky-notes', key: 'unread' } as const, 0)
const pendingAtom = atom({ plugin: 'cc-sticky-notes', key: 'pending' } as const, 0)
const lastTurnAtom = atom({ plugin: 'cc-sticky-notes', key: 'lastTurnId' } as const, null)
const turnsAtSidebarAtom = atom({ plugin: 'cc-sticky-notes', key: 'turnsAtLastSidebar' } as const, 0)

function portsOf($: EngineInterface): Ports {
  return {
    sessionId: () => $.session.id(),
    projectRoot: () => $.session.root(),
    turns: () => $.session.turns(),
    messages: async () => {
      const list = await $.session.messages()
      return Array.isArray(list) ? list : []
    },
    now: () => $.clock.now(),
    later: fn => void $.clock.after(0, fn),
    store: { get: key => $.store.get(key), set: (key, value) => $.store.set(key, value) },
    fetch: (url, init) => $.http.fetch(url, init),
    fork: prompt => $.model.fork({ prompt }),
    complete: request => $.model.complete(request),
    keys: { typesafe: () => $.env.get('TYPESAFE_API_KEY'), openai: () => $.env.get('OPENAI_API_KEY') },
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
      suggest: async text => void (await $.prompt.suggest({ text })),
    },
    state: {
      publishTree: async tree => void (await update($, treeAtom, () => tree)),
      lastTurnId: () => read($, lastTurnAtom),
      turnsAtLastSidebar: () => read($, turnsAtSidebarAtom),
      setTurnsAtLastSidebar: async n => void (await update($, turnsAtSidebarAtom, () => n)),
      addPending: async delta => void (await update($, pendingAtom, n => Math.max(0, n + delta))),
      addUnread: async delta => void (await update($, unreadAtom, n => Math.max(0, n + delta))),
    },
  }
}

/** Pane click: show it, make it this session's activeThread, hint in the prompt box. */
async function selectNode($: EngineInterface, id: string | null) {
  const p = portsOf($)
  const sessionId = await p.sessionId()
  await update($, selectedAtom, () => id)
  const tree = await change(p, t => setActive(t, sessionId, id))
  const title = id === null ? null : (tree.nodes[id]?.title ?? null)
  // How the suggestion looks in Desktop is unverified (PROBE.md).
  if (title !== null) await p.ui.suggest(`正在追問：${title}`)
}

export const register: Register = (on, options) => {
  const opts = readOptions(options)

  on('session.start', async ($, e, next) => {
    await $.command.register(COMMAND_SPEC)
    await refresh(portsOf($))
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    await update($, lastTurnAtom, () => e.turnId)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    // Only the person's own typed prompts are routed; notifications, peers and plugins pass.
    if (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge') return next(e)
    if (e.text.trim() === '' || e.text.trimStart().startsWith('/')) return next(e)

    const p = portsOf($)
    const d = await routePrompt(p, opts, e.text)
    switch (d.kind) {
      case 'main':
      case 'ask':
        return next(e)
      case 'project_question':
        // TODO(M1): the promotedAt bookmark node (待討論 in PROBE.md).
        return next({ ...e, context: [...(e.context ?? []), d.context] })
      case 'sidebar':
        await startNote(p, opts, {
          question: e.text,
          attach: { kind: d.attach },
          answerer: d.answerer,
          route: d.route,
          tag: d.tag.kind === 'existing' ? d.tag.tag : undefined,
        })
        // The drop reason is shown to the user as a notice (PROBE.md): it is the transparency line.
        return { drop: dropReason(e.text) }
    }
  })

  on('command.run', { command: COMMAND }, async ($, e) => runCommand(portsOf($), opts, e.args))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const data = { tree: await read($, treeAtom), unread: await read($, unreadAtom), pending: await read($, pendingAtom) }
    return bandView($.ui.resolve(e), data, () => void portsOf($).ui.openPane())
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const data = { tree: await read($, treeAtom), selectedId: await read($, selectedAtom), sessionId: await $.session.id() }
    return paneView($.ui.resolve(e), data, { select: id => void selectNode($, id) })
  })
}
