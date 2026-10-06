// cc-sticky-notes type contract.
// Data model (PLAN.md「資料模型」) plus the $.state values the pane draws from.
// Self-contained: no imports. Hooks modules import these from '../types'.

/** How a prompt was routed. `ask` = the user picked in $.ui.ask. */
export type RouteSource = 'jev' | 'ask' | 'manual'

/** Who wrote a node's answer. */
export type AnsweredBy = 'claude-fork' | 'claude' | 'openai' | 'manual'

/** Bookmark: where in the main line the curiosity happened. */
export type Anchor = {
  sessionId: string
  turnId: string | null
  at: number
  /** Last main-line user prompt, first 120 chars. Debug only. */
  mainSnippet: string
}

/** One Q/A in the tree. Root when parentId is null. */
export type TreeNode = {
  id: string
  parentId: string | null
  /** Only roots carry it; at most one outline per root. */
  outlineId: string | null
  anchor: Anchor
  question: string
  answer: string
  answeredBy: AnsweredBy
  /** ≤ 12 chars; falls back to the first 12 chars of the question. */
  title: string
  /** Three sentences; null until the summary layer fills it. */
  summary: string | null
  tags: string[]
  route: { label: string; confidence: number; source: RouteSource }
  promotedAt: number | null
  promotedTo: string | null
  children: string[]
}

/** A grouping over roots. Not part of the tree; cannot be nested. */
export type Outline = {
  id: string
  title: string
  outline: string
  /** Root ids only. */
  memberIds: string[]
  createdAt: number
  staleSince: number | null
}

export type MainDigest = {
  text: string
  updatedAtTurn: string
  updatedAt: number
  sessionId: string
}

/** $.store key `tree:${projectRoot}`; shared by every session of the project. */
export type Tree = {
  version: 2
  nodes: Record<string, TreeNode>
  roots: string[]
  outlines: Record<string, Outline>
  /** key = sessionId; each session keeps its own "currently following up". */
  activeThread: Record<string, string | null>
  tags: string[]
  mainDigest: MainDigest | null
}

declare module 'claude-code' {
  interface PluginState {
    'cc-sticky-notes': {
      /** Mirror of the stored tree for drawing; null before session.start loads it. */
      tree: Tree | null
      /** Node shown in the pane's answer area. */
      selectedId: string | null
      /** Unread sidebar answers since the pane was last opened (badge count). */
      unread: number
      /** "只看本 session" filter. */
      onlyThisSession: boolean
      /** Outline selection mode and the roots picked in it. */
      selectMode: boolean
      selection: string[]
      /** Sidebar answers in flight, for a "thinking…" row. */
      pending: number
      /** Last main-line turnId seen at turn.start (prompt.submit has none while idle). */
      lastTurnId: string | null
      /** $.session.turns() when the last sidebar note was made; feeds main_turns_since_last_sidebar. */
      turnsAtLastSidebar: number
    }
  }
}
