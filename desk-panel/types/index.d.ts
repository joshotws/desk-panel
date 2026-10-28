export type PlanStatus = 'pending' | 'in_progress' | 'completed'

/** 計畫清單的一項：來自 TodoWrite，或 TaskCreate／TaskUpdate／TaskList */
export type PlanItem = {
  id: string
  text: string
  /** 進行中時顯示的現在進行式（activeForm） */
  active?: string
  status: PlanStatus
}

export type Plan = {
  items: PlanItem[]
  /** ExitPlanMode 最後核准的計畫全文 */
  planText: string | null
}

export type UsageLimit = {
  /** five_hour、seven_day 或閘道的 spend_limit */
  kind: string
  percent: number
  /** ISO 8601 */
  resetsAt?: string
}

export type Usage = {
  contextPercent?: number
  contextTokens?: number
  /** 模型的 context window；取不到時沒有 */
  contextWindow?: number
  /** 訂閱制才有 5 小時／每週額度；API key、Bedrock／Vertex 等按 token 計費時是空的 */
  limits: UsageLimit[]
  /** 本工作階段的花費（美元）；宿主沒有記帳時沒有 */
  costUsd?: number
  /** 每分鐘變一次，讓面板上的相對時間跟著更新 */
  minute: number
}

export type BgTaskKind = 'shell' | 'monitor' | 'agent'

export type BgTask = {
  id: string
  kind: BgTaskKind
  label: string
  /** running、completed、failed、killed、expired，或代理的狀態 */
  status: string
  startedAt: number
  endedAt?: number
  /** 監看（Monitor）的逾時時刻；沒有通知會告知它到期 */
  expiresAt?: number
}

/** Edit／Write 結果 structuredPatch 的一段 hunk */
export type Hunk = {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

/** 這個工作階段 Claude 改過的一個檔案 */
export type FileChange = {
  /** 正規化（正斜線、小寫）後的路徑，當作識別與按鈕 key */
  key: string
  path: string
  added: number
  removed: number
  edits: number
  /** Write 建立的新檔 */
  created: boolean
  lastAt: number
  /** 最近一次編輯的 hunks（已截短，行數與 @@ 標頭一致） */
  lastHunks: Hunk[]
}

export type RunningTool = {
  id: string
  tool: string
  summary: string
  startedAt: number
}

export type Activity = {
  running: RunningTool[]
  /** 這個工作階段各工具的呼叫次數 */
  counts: Record<string, number>
  errors: number
  /** 目前（或最近一個）主回合的工具次數 */
  turnTools: number
  turnStartedAt?: number
  lastTurnMs?: number
}

export type Header = {
  /** 取不到時是空字串 */
  model: string
  root: string
  /** 目前所在的資料夾（和狀態列的 workspace.current_dir 同一個） */
  cwd: string
  /** 工作階段開始的時刻；用量還沒取到過時沒有 */
  startedAt?: number
  /** 取不到時沒有 */
  turns?: number
}

/** git status 裡一個未 commit 的檔案；added／removed 來自 git diff HEAD --numstat（未追蹤或二進位檔沒有） */
export type GitFile = {
  /** 正規化（正斜線、小寫）的絕對路徑，和 FileChange.key 同一套，用來比對 */
  key: string
  /** repo 內的相對路徑 */
  path: string
  /** porcelain 狀態碼：M、A、D、R、?? … */
  status: string
  added?: number
  removed?: number
}

export type GitCommit = {
  hash: string
  subject: string
  /** epoch 毫秒 */
  at: number
}

export type GitInfo = {
  root: string
  branch: string
  /** 有 upstream 時才有 */
  ahead?: number
  behind?: number
  /** 未 commit 的檔案，最多存前 100 筆 */
  files: GitFile[]
  /** 未 commit 的檔案總數；舊版本存的沒有這個欄位時以 files 的長度代替 */
  fileCount?: number
  last?: GitCommit
  /** 這個工作階段開始後的 commit */
  sessionCommits: GitCommit[]
}

/** /context 的一個類別 */
export type ContextSlice = {
  name: string
  tokens: number
  color: string
  /** used、free、buffer、deferred */
  kind: string
}

export type ContextInfo = {
  slices: ContextSlice[]
  total: number
  max: number
}

/**
 * 會在面板上標出錯誤的資料來源：工具呼叫記錄的 plan／changes／tasks／activity，
 * 每 5 秒輪詢的 usage／header／agents，以及 git、context
 */
export type IssueSource = 'plan' | 'changes' | 'tasks' | 'activity' | 'usage' | 'header' | 'agents' | 'git' | 'context'

declare module 'claude-code' {
  interface PluginState {
    'desk-panel': {
      plan: Plan
      usage: Usage | null
      tasks: BgTask[]
      changes: FileChange[]
      /** Changes 裡展開 diff 預覽的檔案 key */
      expanded: string | null
      activity: Activity
      header: Header | null
      /** 主迴圈最近一次模型請求的 effort（low…max）；第一次請求前是 null */
      effort: string | null
      /** 有工具執行中時每 5 秒加一，讓經過秒數跟著更新 */
      tick: number
      git: GitInfo | null
      /** 點開「其他未 commit 變更」時才向 git 取的 diff，依 GitFile.key；null 表示取不到 */
      gitDiffs: Record<string, Hunk[] | null>
      context: ContextInfo | null
      /** 收合中的區塊 id；也存在 $.store，跨工作階段沿用 */
      collapsed: string[]
      /** 各資料來源（IssueSource）最近一次失敗的原因，成功就移除；對應的區塊會標出來 */
      issues: Record<string, string>
    }
  }
}
