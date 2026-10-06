// /sticky-note and its subcommands.
import type { CommandRunResult } from 'claude-code'

import { change, dropReason, startNote, type Options } from './notes'
import type { Ports } from './ports'
import { setActive } from './tree'

export const COMMAND = 'sticky-note'

export const COMMAND_SPEC = {
  name: COMMAND,
  description: 'Sticky Notes: open/close the pane, or new | back | promote | outline | refresh | digest | export | mode | stats',
  argumentHint: '[new <問題> | back | …]',
}

const LATER: Record<string, string> = {
  promote: 'M3',
  outline: 'M3',
  refresh: 'M3',
  digest: 'M3',
  export: 'M3',
  mode: 'M4',
  stats: 'M4',
}

export function parseArgs(args: string): { sub: string; rest: string } {
  const m = /^\s*(\S*)\s*([\s\S]*)$/.exec(args)
  return { sub: (m?.[1] ?? '').toLowerCase(), rest: (m?.[2] ?? '').trim() }
}

export async function runCommand(p: Ports, opts: Options, args: string): Promise<CommandRunResult> {
  const { sub, rest } = parseArgs(args)
  switch (sub) {
    case '': {
      if (await p.ui.isPaneOpen()) await p.ui.closePane()
      else await p.ui.openPane()
      return {}
    }
    case 'new': {
      if (rest === '') return { text: '用法：/sticky-note new <問題>' }
      await startNote(p, opts, {
        question: rest,
        attach: { kind: 'root' },
        answerer: 'fork',
        route: { label: 'sidebar_knowledge', confidence: 1, source: 'manual' },
      })
      p.ui.toast(dropReason(rest))
      return {}
    }
    case 'back': {
      const sessionId = await p.sessionId()
      await change(p, t => setActive(t, sessionId, null))
      return {}
    }
    default: {
      const when = LATER[sub]
      return { text: when ? `/sticky-note ${sub}：尚未實作（${when}）` : `未知的子指令：${sub}` }
    }
  }
}
