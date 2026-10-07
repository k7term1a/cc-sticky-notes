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
  /** Last main-line turn before the question (turn.start); idle prompts carry none. */
  turnId: string | null
  /** uuid of the main-line user message before the question (session.append door='prompt'). UserMessage badge / $.ui.scroll (M2). */
  messageId: string | null
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
  /** The session it was promoted in (promotion only goes into the current session). */
  promotedIn: string | null
  /** Derived on load from the children's parentId (never trusted from the store), ordered by anchor.at. */
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

/** $.store `meta:<root>`. */
export type TreeMeta = {
  version: 2
  tags: string[]
  mainDigest: MainDigest | null
}

/**
 * The whole tree of one project, as assembled in memory from its keys:
 * node:<root>:<id>, outline:<root>:<id>, active:<root>:<sessionId>, meta:<root>.
 * Every session of the project (forks, restarts, other worktrees) shares it.
 */
export type Tree = {
  nodes: Record<string, TreeNode>
  /** Derived: parentId === null, ordered by anchor.at. */
  roots: string[]
  outlines: Record<string, Outline>
  /** key = sessionId; each session keeps its own "currently following up". */
  activeThread: Record<string, string | null>
  tags: string[]
  mainDigest: MainDigest | null
}

/** Routing labels the user can say were right. */
export type RouteChoice = 'main' | 'sidebar' | 'followup' | 'project_question'

/** What the user said about one routing decision. */
export type RouteFeedback = {
  verdict: 'right' | 'wrong'
  /** What it should have been; null when unknown. */
  expected: RouteChoice | null
  at: number
  source: 'command' | 'ask' | 'reclassify' | 'pane'
}

/**
 * One routing decision kept for calibrating the thresholds (PLAN.md: 50 real prompts).
 * $.store `route:<root>:<id>`, local only, capped per project.
 */
export type RouteSample = {
  id: string
  at: number
  sessionId: string
  /** First 200 characters of the prompt. Stays in the local store. */
  prompt: string
  /** Jev's raw answer; null when Jev was unavailable. */
  jev: { route: string; confidence: number; isFollowup: number; needsProjectCtx: number; tag: string | null } | null
  thresholds: { route: number; followup: number; needsCtx: number }
  /** What the decision table did. */
  decision: 'main' | 'sidebar' | 'followup' | 'project_question' | 'ask'
  /** The node it made, if any. */
  nodeId: string | null
  feedback: RouteFeedback | null
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
      /** uuid of the last main-line user message (session.append door='prompt'). */
      lastPromptUuid: string | null
      /** The last routing sample of this session, for /sticky-note feedback. */
      lastSampleId: string | null
      /** /sticky-note ui-demo: label every place the mod can draw, to choose where the UI goes. */
      uiDemo: boolean
    }
  }
}
