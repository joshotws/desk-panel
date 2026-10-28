import { atom, read, update } from 'claude-code'
import type { AgentInfo, EngineInterface, Register, SessionUsage, Timer } from 'claude-code'

import type {
  Activity,
  BgTask,
  ContextInfo,
  FileChange,
  GitCommit,
  GitFile,
  GitInfo,
  Header,
  Hunk,
  IssueSource,
  Plan,
  PlanItem,
  PlanStatus,
  RunningTool,
  Usage,
  UsageLimit,
} from '../types'

const PANE = 'desk-panel'
const TITLE = 'Session'
// 停靠在 fullscreen 版面右側時想要的欄寬；引擎會限制在 24 欄到終端機寬度的 45%
const DOCK_COLUMNS = 52
// $.store 的鍵：上次用 /panel 開著面板，新工作階段就自動開啟；收合中的區塊
const AUTO_OPEN = 'autoOpen'
const COLLAPSED = 'collapsed'
const DEFAULT_COLLAPSED = ['activity', 'context']
// 已結束的背景任務保留幾筆、保留多久
const KEEP_FINISHED = 6
const FINISHED_TTL_MS = 30 * 60_000
// 計畫清單最多顯示幾項、已核准計畫最多顯示幾行
const MAX_PLAN_ITEMS = 14
const MAX_PLAN_LINES = 6
// Changes 每組最多列幾個檔案、每個檔案保留幾行 diff、展開時顯示幾行
const MAX_FILES = 12
const KEEP_DIFF_LINES = 60
const SHOW_DIFF_LINES = 16
// 編輯或指令結束後，等這麼久沒有新動作才重跑 git
const GIT_DEBOUNCE_MS = 2000
const MAX_SESSION_COMMITS = 5
// git status 最多存幾個檔案進狀態（總數另外記，Git 區塊照樣顯示真實數字）
const MAX_GIT_FILES = 100
// Activity 的「各工具次數」列幾種、Context 列幾個類別
const TOP_TOOLS = 6
const TOP_CONTEXT = 6
// 每 5 秒輪詢的來源（usage、header、agents）連續失敗幾次才標在面板上：剛開工作階段時可能失敗一次，下一輪就好
const POLL_MISSES = 2
// 面板上的錯誤原因最多顯示幾個字
const MAX_ISSUE_CHARS = 80

const plan = atom({ plugin: 'desk-panel', key: 'plan' } as const, { items: [], planText: null })
const usage = atom({ plugin: 'desk-panel', key: 'usage' } as const, null)
const tasks = atom({ plugin: 'desk-panel', key: 'tasks' } as const, [])
const changes = atom({ plugin: 'desk-panel', key: 'changes' } as const, [])
const expanded = atom({ plugin: 'desk-panel', key: 'expanded' } as const, null)
const activity = atom({ plugin: 'desk-panel', key: 'activity' } as const, { running: [], counts: {}, errors: 0, turnTools: 0 })
const header = atom({ plugin: 'desk-panel', key: 'header' } as const, null)
const effort = atom({ plugin: 'desk-panel', key: 'effort' } as const, null)
const tick = atom({ plugin: 'desk-panel', key: 'tick' } as const, 0)
const git = atom({ plugin: 'desk-panel', key: 'git' } as const, null)
const gitDiffs = atom({ plugin: 'desk-panel', key: 'gitDiffs' } as const, {})
const context = atom({ plugin: 'desk-panel', key: 'context' } as const, null)
const collapsed = atom({ plugin: 'desk-panel', key: 'collapsed' } as const, DEFAULT_COLLAPSED)
const issues = atom({ plugin: 'desk-panel', key: 'issues' } as const, {})

const ENDED = new Set(['completed', 'failed', 'killed', 'stopped', 'expired'])
const PLAN_ICON: Record<PlanStatus, string> = { pending: '○', in_progress: '▶', completed: '✓' }
const KIND_LABEL: Record<BgTask['kind'], string> = { shell: 'shell', monitor: 'monitor', agent: 'agent' }
// 額度名稱照官方 /usage 的寫法
const LIMIT_TITLE: Record<string, string> = {
  five_hour: 'Current session',
  seven_day: 'Current week (all models)',
  seven_day_sonnet: 'Current week (Sonnet only)',
  spend_limit: 'Spend limit',
}
// 訂閱方案才有的額度視窗；用 API key、Bedrock／Vertex 這類按 token 計費的方式調用模型時，回應不會帶這些
const PLAN_WINDOW = /^(five_hour|seven_day)/
const STATUS_WORD: Record<string, string> = { completed: 'done', failed: 'failed', killed: 'stopped', stopped: 'stopped', expired: 'expired' }
// 會改動工作目錄的工具：結束後排程重跑 git
const TOUCHES_FILES = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])
// 從工具呼叫記錄資料時失敗，原因標在這個工具對應的區塊
const TOOL_SECTION: Record<string, IssueSource> = {
  TodoWrite: 'plan',
  TaskCreate: 'plan',
  TaskUpdate: 'plan',
  TaskList: 'plan',
  ExitPlanMode: 'plan',
  Edit: 'changes',
  Write: 'changes',
  NotebookEdit: 'changes',
  Bash: 'tasks',
  PowerShell: 'tasks',
  Monitor: 'tasks',
  TaskStop: 'tasks',
}

type Fields = Record<string, unknown>
// 一個區塊畫出來的東西：標題旁的註記、標題列右邊的按鈕、內容
type Drawn = { note?: string; action?: JSX.Element; body: JSX.Element | null }

// 何時該重跑 git（epoch 毫秒，0 表示沒有待辦）。$ 不能存進變數，所以由每 5 秒的 refresh 來檢查
let gitDueAt = 0
// git 正在跑時再被叫到：先記下，跑完再跑一次，不同時跑兩份
let gitRunning = false
let gitAgain = false
// 面板是否畫出來了：關著時不跑 git、不輪詢用量與子代理，只記錄工具呼叫；
// 畫出來的瞬間（ui.render 第一次被叫到，含自動開啟但先前太窄的情況）排程一次完整更新
let paneOpen = false
let openTimer: Timer | undefined
// 目前替哪個 session id 寫了 open 旗標：狀態列腳本看到 open 就不輸出，資訊改看面板。
// /clear 會換 session id，由 refresh 替新 id 補寫
let flaggedId = ''
// 旗標資料夾 ~/.claude/desk-panel/open：使用者自己建立才寫（表示狀態列會讀）；
// null 是沒有或讀不到，undefined 是還沒查。session.start 與 /panel 時重查
let flagRoot: string | null | undefined
// 主迴圈送出過請求後，effort 只認主迴圈的
let hasMainEffort = false
// 面板最近一次畫出來的尺寸，/panel size 回報用（確認狀態列消失後面板有沒有變高）
let lastSize: { placement: string; bodyRows: number; bodyColumns: number; rows?: number; columns?: number } | undefined
// 各資料來源連續失敗的次數，成功就歸零（重新載入時從頭算，無妨）
const misses = new Map<IssueSource, number>()

export const register: Register = on => {
  // 每一步各自容錯：哪一步失敗都不擋其他步驟，最後一定交給 next
  on('session.start', async ($, e, next) => {
    await attempt(() =>
      $.command.register({
        name: 'panel',
        description: 'Toggle the side panel: plan, changes, tasks, usage, git, activity, context',
        argumentHint: '[close|reset|size]',
      }),
    )
    await attempt(async () => {
      const saved = await $.store.get(COLLAPSED)
      if (Array.isArray(saved)) {
        const ids = saved.filter(isString)
        await update($, collapsed, () => ids)
      }
    })
    await checkFlagRoot($)
    // 面板關著時 refresh 什麼都不做；資料等面板開了再取
    await attempt(async () => $.clock.every(5000, () => void refresh($)))
    if ((await attempt(() => $.store.get(AUTO_OPEN))) === true) {
      void $.ui
        .open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
        .then(async opened => {
          // 太窄而沒畫出來：之後畫出來時由 ui.render 接手
          if (opened.isPlaced) await openPane($)
        })
        .catch(() => {
          // 開不起來就等使用者自己下 /panel
        })
    }

    return next(e)
  })

  // 工作階段結束（含 /clear）：這個 session id 的旗標改回 closed；/clear 後面板還開著，refresh 會替新 id 補寫
  on('session.end', async ($, e, next) => {
    try {
      await writeFlag($, flaggedId, 'closed')
      flaggedId = ''
    } catch {
      // 面板只是旁觀者
    }

    return next(e)
  })

  // 每次送出模型請求時記下 effort，標頭顯示用；串流原封不動往下傳。
  // 以主迴圈的為準，主迴圈的模型沒有 effort（例如經由閘道改用別家模型）就清掉，不留上一個模型的等級；
  // 主迴圈還沒送過請求前（例如重新載入後一直在 fork 裡對話），先用 subagent 的
  on('turn.step', async function* ($, e, next) {
    try {
      const isMain = e.agentId === undefined
      if (isMain || (!hasMainEffort && e.effort !== undefined)) {
        if (isMain) hasMainEffort = true
        const level = e.effort === undefined ? null : String(e.effort)
        if ((await read($, effort)) !== level) await update($, effort, () => level)
      }
    } catch {
      // 同上
    }

    return yield* next(e)
  })

  // 指令本身出錯時回覆原因，不把錯誤丟回去
  on('command.run', { command: 'panel' }, async ($, e) => {
    const arg = String(e.args ?? '').trim()
    try {
      if (arg === 'close') {
        await attempt(() => $.store.set(AUTO_OPEN, false))
        await $.ui.close({ id: PANE })
        await closePane($)

        return { text: 'Panel closed and the status line is back. It will not open on its own in new sessions.' }
      }
      if (arg === 'size') {
        if (lastSize === undefined) return { text: 'The panel has not been drawn yet.' }
        const terminal = lastSize.rows === undefined ? '' : `; terminal ${lastSize.rows} rows × ${lastSize.columns ?? '?'} columns`

        return { text: `Panel (${lastSize.placement}): ${lastSize.bodyRows} rows × ${lastSize.bodyColumns} columns${terminal}.` }
      }
      if (arg === 'reset') {
        await attempt(() => $.store.set(COLLAPSED, DEFAULT_COLLAPSED))
        await update($, collapsed, () => DEFAULT_COLLAPSED)
        await update($, expanded, () => null)
        // 清掉錯誤提示再重新取一次資料：還在出錯的來源會再標出來
        misses.clear()
        await update($, issues, () => ({}))
        if (paneOpen) await refreshAll($)

        return { text: 'Panel layout reset: Activity and Context collapsed, every other section open, warnings cleared.' }
      }
      await attempt(() => $.store.set(AUTO_OPEN, true))
      await checkFlagRoot($)
      const opened = await $.ui.open({ id: PANE, title: TITLE, columns: DOCK_COLUMNS })
      if (!opened.isPlaced) {
        return { text: 'Panel opened, but the terminal is too narrow to show it; widen the window.' }
      }
      await openPane($)

      return {
        text: e.presentation?.isFullscreen
          ? 'Panel opened on the right; the status line hides while it is open. New sessions open it too; /panel close turns it off, /panel reset restores the layout.'
          : 'Panel opened above the prompt (this is not the fullscreen layout).',
      }
    } catch (error) {
      return { text: `/panel${arg === '' ? '' : ` ${arg}`} failed: ${errorText(error)}` }
    }
  })

  // 面板關掉時恢復狀態列；使用者自己按關閉的，之後就不再自動開啟
  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      if (e.origin?.kind === 'person') await attempt(() => $.store.set(AUTO_OPEN, false))
      await closePane($)
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // 只旁觀工具呼叫：記下執行中的工具、次數與錯誤，再從輸入與結果記下計畫、改過的檔案和背景任務。
  // 記錄失敗不影響工具本身，原因標在對應的區塊
  on('tool.call', async ($, e, next) => {
    const input = e as unknown as Fields
    const tool = String(e.tool)
    const id = e.tool_use_id ?? `${tool}-${await clockNow($)}`
    await guard($, 'activity', () => startTool($, id, input))
    const ran = await next(e).catch(async (error: unknown) => {
      await guard($, 'activity', () => endTool($, id, true))
      throw error
    })
    await guard($, 'activity', () => endTool($, id, ran.deny !== undefined || ran.isError === true))
    const section = TOOL_SECTION[tool]
    if (section !== undefined) {
      await guard($, section, () => track($, input, ran.deny === undefined ? (ran.result as Fields | undefined) : undefined))
    }
    if (TOUCHES_FILES.has(tool)) gitDueAt = (await clockNow($)) + GIT_DEBOUNCE_MS

    return ran
  }).catch(($, e, next) => next(e))

  // 背景任務結束時，引擎會送一則 <task-notification> 進對話
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    try {
      if (e.message.type === 'user') {
        for (const block of e.message.content) {
          const text: unknown = block.text
          if (block.type === 'text' && typeof text === 'string' && text.includes('<task-notification>')) {
            await guard($, 'tasks', () => readNotifications($, text))
          }
        }
      }
    } catch {
      // 面板只是旁觀者
    }

    return stored
  }).catch(($, e, next) => next(e))

  // 主回合（不含 subagent）的開始與結束：算本回合工具數與上回合耗時，結束時更新 git 與 context
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await guard($, 'activity', async () => {
        const now = await clockNow($)
        await update($, activity, value => ({ ...activityOf(value), turnTools: 0, turnStartedAt: now }))
      })
    }

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined) {
      await guard($, 'activity', async () => {
        const now = await clockNow($)
        await update($, activity, value => {
          const current = activityOf(value)

          return {
            ...current,
            lastTurnMs: current.turnStartedAt === undefined ? current.lastTurnMs : now - current.turnStartedAt,
            turnStartedAt: undefined,
          }
        })
      })
      gitDueAt = 0
      if (paneOpen) {
        await refreshGit($)
        await refreshContext($)
      }
    }
    await refresh($)

    return done
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Code, Text } = $.ui.resolve(e)
    const bodyColumns = finite(e.props.bodyColumns)
    lastSize = {
      placement: String(e.props.placement),
      bodyRows: finite(e.props.scroll?.bodyRows) ?? 0,
      bodyColumns: bodyColumns ?? 0,
      rows: e.viewport?.rows,
      columns: e.viewport?.columns,
    }
    // 第一次畫出來（含自動開啟時太窄、之後變寬才畫的）：記下已開，排程一次完整更新；這次先畫手上的資料
    if (!paneOpen) {
      paneOpen = true
      openTimer ??= $.clock.after(0, () => {
        openTimer = undefined
        void openPane($)
      })
    }
    const width = Math.max(24, bodyColumns ?? DOCK_COLUMNS)
    const now = await clockNow($)
    // 讀不到（宿主出狀況）就當作沒有；舊版本存下、形狀不對的值先整理過，各區塊再各自容錯
    await read($, tick).catch(() => 0)
    const head = await read($, header).catch(() => null)
    const level = await read($, effort).catch(() => null)
    const p = planOf(await read($, plan).catch(() => null))
    const files = listOf(await read($, changes).catch(() => null))
    const open = await read($, expanded).catch(() => null)
    const list = listOf(await read($, tasks).catch(() => null))
    const u = await read($, usage).catch(() => null)
    const repo = await read($, git).catch(() => null)
    const diffs = recordOf(await read($, gitDiffs).catch(() => null))
    const ctx = await read($, context).catch(() => null)
    const act = activityOf(await read($, activity).catch(() => null))
    const folded = listOf(await read($, collapsed).catch(() => DEFAULT_COLLAPSED)).filter(isString)
    const problems = recordOf(await read($, issues).catch(() => null))

    const isOpen = (id: string) => !folded.includes(id)
    const sectionHeader = (id: string, title: string, note: string) => (
      <Button key={`section:${id}`} plain onPress={press($, 'fold the section', () => toggleSection($, id))}>
        {isOpen(id) ? '▾' : '▸'} <Text bold color="claude">{title}</Text>
        {note === '' ? '' : <Text dimColor>{`  ${note}`}</Text>}
      </Button>
    )
    // 某個資料來源最近一次失敗的原因；沒有失敗就不畫
    const issueLine = (source: IssueSource, label: string) => {
      const message = problems[source]

      return message === undefined ? null : (
        <Text color="warning" wrap="truncate-end">
          {`⚠ ${label}: ${message}`}
        </Text>
      )
    }
    // 畫不出來的部分改顯示原因，不讓整個面板一起失敗
    const failed = (what: string, error: unknown) => (
      <Text color="warning" wrap="truncate-end">
        {`⚠ could not draw ${what}: ${errorText(error)}`}
      </Text>
    )
    // 每個區塊各自 try：資料不對或畫的時候出錯，只有這個區塊改顯示原因，其他區塊照畫
    const section = (id: string, title: string, draw: () => Drawn) => {
      let drawn: Drawn
      try {
        drawn = draw()
      } catch (error) {
        drawn = { note: '⚠', body: failed('this section', error) }
      }
      const top = sectionHeader(id, title, drawn.note ?? '')

      return (
        <Box flexDirection="column">
          {drawn.action === undefined ? (
            top
          ) : (
            <Box flexDirection="row" justifyContent="space-between">
              {top}
              {drawn.action}
            </Box>
          )}
          {isOpen(id) && drawn.body}
        </Box>
      )
    }

    let headBlock: JSX.Element | null
    try {
      if (head === null) {
        headBlock = issueLine('header', 'session info unavailable')
      } else {
        const model = typeof head.model === 'string' ? head.model : ''
        const startedAt = positive(head.startedAt)
        const turns = finite(head.turns)
        const facts = [
          startedAt === undefined ? '' : durationText(now - startedAt),
          turns === undefined ? '' : `${turns} ${turns === 1 ? 'turn' : 'turns'}`,
        ].filter(fact => fact !== '')
        const folder = baseName(String(head.cwd || head.root || ''))
        headBlock = (
          <Box flexDirection="column">
            {model === '' ? (
              <Text dimColor>(model unknown)</Text>
            ) : (
              <Text bold wrap="truncate-end">
                {model}
              </Text>
            )}
            <Box flexDirection="row">
              {level !== null && <Text color="claude">{effortText(String(level))}</Text>}
              <Text dimColor wrap="truncate-end">
                {level !== null && facts.length > 0 ? '  ·  ' : ''}
                {facts.join('  ·  ')}
              </Text>
            </Box>
            <Box flexDirection="row">
              <Text wrap="truncate-end">{folder === '' ? '(folder unknown)' : folder}</Text>
              {repo !== null && typeof repo.branch === 'string' && <Text dimColor>{`  (${repo.branch})`}</Text>}
            </Box>
            {issueLine('header', 'session info')}
          </Box>
        )
      }
    } catch (error) {
      headBlock = failed('the header', error)
    }

    const planBlock = section('plan', 'Plan', () => {
      const done = p.items.filter(item => item.status === 'completed').length
      const planLines = (p.planText ?? '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
        .slice(0, MAX_PLAN_LINES)

      return {
        note: p.items.length > 0 ? `${done}/${p.items.length}` : '',
        body: (
          <Box flexDirection="column">
            {p.items.length === 0 && planLines.length === 0 && <Text dimColor>(no plan or todos yet)</Text>}
            {p.items.slice(0, MAX_PLAN_ITEMS).map(item => (
              <Text
                wrap="truncate-end"
                bold={item.status === 'in_progress'}
                color={item.status === 'in_progress' ? 'claude' : 'text'}
                dimColor={item.status === 'completed'}
                strikethrough={item.status === 'completed'}
              >
                {PLAN_ICON[item.status] ?? '○'} {String(item.status === 'in_progress' && item.active ? item.active : item.text)}
              </Text>
            ))}
            {p.items.length > MAX_PLAN_ITEMS && <Text dimColor>…{p.items.length - MAX_PLAN_ITEMS} more</Text>}
            {planLines.length > 0 && <Text dimColor>Approved plan:</Text>}
            {planLines.map(line => (
              <Text dimColor wrap="truncate-end">
                {'  '}
                {line}
              </Text>
            ))}
            {issueLine('plan', 'plan tracking failed')}
          </Box>
        ),
      }
    })

    const changesBlock = section('changes', 'Changes', () => {
      const added = files.reduce((sum, file) => sum + file.added, 0)
      const removed = files.reduce((sum, file) => sum + file.removed, 0)
      const claudeKeys = new Set(files.map(file => file.key))
      const others = listOf(repo?.files)
        .filter(file => !claudeKeys.has(file.key))
        .slice(0, MAX_FILES)
      const fileCount = files.length + others.length

      return {
        note: fileCount > 0 ? `${fileCount} ${fileCount === 1 ? 'file' : 'files'}` : '',
        action:
          fileCount > 0 ? (
            <Button key="open-diff" label="Open /diff" onPress={press($, 'open /diff', () => $.command.run({ command: 'diff' }))} />
          ) : undefined,
        body: (
          <Box flexDirection="column">
            {fileCount === 0 && <Text dimColor>(no files changed yet)</Text>}
            {files.length > 0 && (
              <Box flexDirection="row">
                <Text dimColor>By Claude </Text>
                <Text color="success">+{added}</Text>
                <Text> </Text>
                <Text color="error">−{removed}</Text>
                <Text dimColor>  · press a file for its diff</Text>
              </Box>
            )}
            {files.map(file => {
              const stats = `+${file.added} −${file.removed} ${durationText(now - file.lastAt)}`
              const shown = shortPath(relativePath(file.path, repo?.root ?? (head?.root || undefined)), Math.max(8, width - stats.length - 7))
              const hunks = listOf(file.lastHunks)

              return (
                <Box flexDirection="column">
                  <Button
                    key={file.key}
                    plain
                    onPress={press($, 'show the diff', () => update($, expanded, current => (current === file.key ? null : file.key)))}
                  >
                    {open === file.key ? '▾' : '▸'} {file.created ? 'A' : 'M'} {shown} <Text color="success">+{file.added}</Text>{' '}
                    <Text color="error">−{file.removed}</Text> <Text dimColor>{durationText(now - file.lastAt)}</Text>
                  </Button>
                  {open === file.key &&
                    (hunks.length > 0 ? (
                      <Code source={diffText(hunks, SHOW_DIFF_LINES)} format="diff" path={file.path} wrap="truncate-end" />
                    ) : (
                      <Text dimColor>{'  '}(no diff recorded)</Text>
                    ))}
                </Box>
              )
            })}
            {others.length > 0 && <Text dimColor>Other uncommitted changes</Text>}
            {others.map(file => {
              const key = `git:${file.key}`
              const counts = file.added === undefined ? '' : `+${file.added} −${file.removed ?? 0}`
              const shown = shortPath(file.path, Math.max(8, width - counts.length - 7))
              const hunks = diffs[file.key]

              return (
                <Box flexDirection="column">
                  <Button
                    key={key}
                    plain
                    dimColor
                    onPress={press($, 'load the diff', async () => {
                      await update($, expanded, current => (current === key ? null : key))
                      if (hunks === undefined) await loadGitDiff($, file)
                    })}
                  >
                    {open === key ? '▾' : '▸'} {file.status} {shown}
                    {file.added === undefined ? '' : <Text color="success">{` +${file.added}`}</Text>}
                    {file.removed === undefined ? '' : <Text color="error">{` −${file.removed}`}</Text>}
                  </Button>
                  {open === key &&
                    (file.status === '?' ? (
                      <Text dimColor>{'  '}(untracked file)</Text>
                    ) : hunks === undefined ? (
                      <Text dimColor>{'  '}(loading diff…)</Text>
                    ) : hunks === null ? (
                      <Text dimColor>{'  '}(diff unavailable)</Text>
                    ) : hunks.length > 0 ? (
                      <Code source={diffText(hunks, SHOW_DIFF_LINES)} format="diff" path={file.path} wrap="truncate-end" />
                    ) : (
                      <Text dimColor>{'  '}(no textual diff)</Text>
                    ))}
                </Box>
              )
            })}
            {issueLine('changes', 'change tracking failed')}
          </Box>
        ),
      }
    })

    const tasksBlock = section('tasks', 'Background tasks', () => {
      const running = list.filter(task => task.endedAt === undefined)
      const finished = list.filter(task => task.endedAt !== undefined)
      const hasAgents = list.some(task => task.kind === 'agent')

      return {
        note: running.length > 0 ? `${running.length} running` : '',
        body: (
          <Box flexDirection="column">
            {list.length === 0 && <Text dimColor>(no background tasks)</Text>}
            {hasAgents && <Text dimColor>press an agent to view its transcript</Text>}
            {[...running, ...finished].map(task => {
              const label = String(task.label)
              const time =
                task.endedAt === undefined
                  ? durationText(now - task.startedAt)
                  : `${STATUS_WORD[task.status] ?? task.status} ${durationText(task.endedAt - task.startedAt)}`

              return task.kind === 'agent' ? (
                <Button key={`agent:${task.id}`} plain onPress={press($, 'open the agent view', () => $.ui.view({ agentId: task.id }))}>
                  <Text color={taskColor(task)}>{taskIcon(task)}</Text> {KIND_LABEL[task.kind]}{' '}
                  {shortText(label, Math.max(8, width - time.length - 12))} <Text dimColor>{time}</Text>
                </Button>
              ) : (
                <Box flexDirection="row" justifyContent="space-between">
                  <Text wrap="truncate-end" color={taskColor(task)} dimColor={task.endedAt !== undefined}>
                    {taskIcon(task)} {KIND_LABEL[task.kind] ?? task.kind} {label}
                  </Text>
                  <Text dimColor> {time}</Text>
                </Box>
              )
            })}
            {issueLine('tasks', 'task tracking failed')}
            {issueLine('agents', 'subagent list unavailable')}
          </Box>
        ),
      }
    })

    // 訂閱制的回應帶 5 小時／每週額度；用 API key、Bedrock／Vertex 等按 token 計費時沒有這些（rateLimits 是空的），
    // 改成說明沒有方案額度。花費是 Claude Code 依 token 數與內建價目估的，算不出來（0 或沒有，
    // 例如閘道後面不是 Claude 的模型）就不顯示
    const usageBlock = section('usage', 'Usage', () => {
      if (u === null) {
        return {
          note: problems.usage === undefined ? '' : '⚠',
          body: problems.usage === undefined ? <Text dimColor>(numbers appear after the first response)</Text> : issueLine('usage', 'usage unavailable'),
        }
      }
      const limits = listOf(u.limits)
      const isOnPlan = limits.some(limit => PLAN_WINDOW.test(String(limit.kind)))
      // 已經有過回應：context 有 token 數，或已經有花費
      const hasResponse = finite(u.contextTokens) !== undefined || (finite(u.costUsd) ?? 0) > 0
      const isMetered = !isOnPlan && hasResponse
      const cost = positive(u.costUsd)
      const barCells = Math.max(6, Math.min(30, width - 11))
      // 標題、「N% used」與「Resets …」照官方 /usage：session 只顯示時刻，其餘額度一律帶日期
      const meters = [
        { title: 'Context', percent: finite(u.contextPercent), note: contextNote(u) },
        ...limits.map(limit => ({
          title: LIMIT_TITLE[limit.kind] ?? String(limit.kind),
          percent: finite(limit.percent),
          note: typeof limit.resetsAt === 'string' ? resetText(limit.resetsAt, now, limit.kind !== 'five_hour') : '',
        })),
      ]

      return {
        note: isMetered ? 'API billing' : '',
        body: (
          <Box flexDirection="column">
            {meters.map(meter => (
              <Box flexDirection="column">
                <Text>{meter.title}</Text>
                <Box flexDirection="row">
                  <Text color={levelColor(meter.percent)}>{bar(meter.percent, barCells)}</Text>
                  <Text>{meter.percent === undefined ? ' —' : ` ${Math.floor(meter.percent)}% used`}</Text>
                </Box>
                {meter.note !== '' && (
                  <Text dimColor wrap="truncate-end">
                    {meter.note}
                  </Text>
                )}
              </Box>
            ))}
            {!isOnPlan && (
              <Text dimColor>{hasResponse ? 'Plan limits: none (billed per token via API)' : 'Plan limits: shown after the first response'}</Text>
            )}
            {cost !== undefined && (
              <Text dimColor>
                Total cost: ${cost.toFixed(2)}
                {isOnPlan ? ' (API pricing)' : ' (pay-as-you-go)'}
              </Text>
            )}
            {issueLine('usage', 'last update failed')}
          </Box>
        ),
      }
    })

    const gitBlock = section('git', 'Git', () => {
      if (repo === null) {
        return {
          note: problems.git === undefined ? '' : '⚠',
          body: problems.git === undefined ? <Text dimColor>(not a git repository)</Text> : issueLine('git', 'git unavailable'),
        }
      }
      // 存進狀態的清單有上限，總數另外記；舊版本存的沒有總數就數清單
      const fileCount = finite(repo.fileCount) ?? listOf(repo.files).length
      const sessionCommits = listOf(repo.sessionCommits)

      return {
        note: String(repo.branch),
        body: (
          <Box flexDirection="column">
            <Text dimColor wrap="truncate-end">
              {repo.ahead === undefined ? '' : `↑${repo.ahead} ↓${repo.behind ?? 0}  ·  `}
              {fileCount} uncommitted {fileCount === 1 ? 'file' : 'files'}
            </Text>
            {sessionCommits.length === 0 && repo.last !== undefined && (
              <Box flexDirection="row">
                <Text color="warning">{repo.last.hash}</Text>
                <Text wrap="truncate-end"> {repo.last.subject}</Text>
                <Text dimColor> {durationText(now - repo.last.at)}</Text>
              </Box>
            )}
            {sessionCommits.length > 0 && (
              <Text dimColor>
                This session: {sessionCommits.length} {sessionCommits.length === 1 ? 'commit' : 'commits'}
              </Text>
            )}
            {sessionCommits.map(commit => (
              <Box flexDirection="row">
                <Text color="warning">{commit.hash}</Text>
                <Text wrap="truncate-end"> {commit.subject}</Text>
              </Box>
            ))}
            {issueLine('git', 'last refresh failed')}
          </Box>
        ),
      }
    })

    const activityBlock = section('activity', 'Activity', () => {
      const topTools = Object.entries(act.counts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, TOP_TOOLS)

      return {
        note: act.running.length > 0 ? `${act.running.length} running` : '',
        body: (
          <Box flexDirection="column">
            {act.running.map(run => (
              <Box flexDirection="row" justifyContent="space-between">
                <Text wrap="truncate-end" color="warning">
                  ▶ {String(run.tool)}
                  {run.summary ? `  ${run.summary}` : ''}
                </Text>
                <Text dimColor> {elapsedText(now - run.startedAt)}</Text>
              </Box>
            ))}
            <Text dimColor wrap="truncate-end">
              This turn: {act.turnTools} {act.turnTools === 1 ? 'tool' : 'tools'}
              {act.lastTurnMs !== undefined ? `  ·  last turn ${elapsedText(act.lastTurnMs)}` : ''}
            </Text>
            {topTools.length > 0 && (
              <Text dimColor>
                {topTools.map(([tool, count]) => `${tool} ${count}`).join(' · ')}
                {act.errors > 0 ? ` · ${act.errors} ${act.errors === 1 ? 'error' : 'errors'}` : ''}
              </Text>
            )}
            {issueLine('activity', 'activity tracking failed')}
          </Box>
        ),
      }
    })

    const contextBlock = section('context', 'Context', () => {
      if (ctx === null) {
        return {
          note: problems.context === undefined ? '' : '⚠',
          body: problems.context === undefined ? <Text dimColor>(available after the first response)</Text> : issueLine('context', 'breakdown unavailable'),
        }
      }
      const slices = listOf(ctx.slices)
      const max = finite(ctx.max) ?? 0
      const total = finite(ctx.total) ?? 0
      const rows = [
        ...slices
          .filter(slice => slice.kind === 'used' || slice.kind === 'deferred')
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, TOP_CONTEXT),
        ...slices.filter(slice => slice.kind === 'buffer' || slice.kind === 'free'),
      ]

      return {
        note: max === 0 ? '' : `${Math.round((total / max) * 100)}% used`,
        body: (
          <Box flexDirection="column">
            <Box flexDirection="row">
              {contextBar({ slices, total, max }, Math.max(10, Math.min(50, width - 2))).map(segment => (
                <Text color={segment.color}>{segment.text}</Text>
              ))}
            </Box>
            {rows.map(slice => (
              <Box flexDirection="row" justifyContent="space-between">
                <Box flexDirection="row">
                  <Text color={slice.color}>{slice.kind === 'free' ? '░' : slice.kind === 'buffer' ? '▒' : '■'} </Text>
                  <Text wrap="truncate-end">{String(slice.name)}</Text>
                </Box>
                <Text dimColor> {tokensText(slice.tokens)}</Text>
              </Box>
            ))}
            {issueLine('context', 'last refresh failed')}
          </Box>
        ),
      }
    })

    return (
      <Box flexDirection="column" gap={1}>
        {headBlock}
        {planBlock}
        {changesBlock}
        {tasksBlock}
        {usageBlock}
        {gitBlock}
        {activityBlock}
        {contextBlock}
      </Box>
    )
  }).catch(($, e, next) => {
    // 最後一道防線：整個面板都畫不出來時（例如畫出來的樹被引擎拒絕），顯示原因與復原方式
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        <Text color="warning">⚠ The panel could not be drawn.</Text>
        <Text dimColor wrap="truncate-end">
          {errorText(next.error.message ?? (next.error.kind === 'timeout' ? 'drawing timed out' : 'drawing failed'))}
        </Text>
        <Text dimColor>Try /panel reset, or /reload-plugins.</Text>
      </Box>
    )
  })
}

// ---------- 容錯 ----------

// 盡力而為的呼叫：失敗就回 undefined
async function attempt<T>(run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run()
  } catch {
    return undefined
  }
}

// 跑一個資料來源：成功就清掉它在面板上的錯誤提示；失敗就記下原因（連續 after 次才標出來）並回 undefined
async function guard<T>($: EngineInterface, source: IssueSource, run: () => Promise<T>, after = 1): Promise<T | undefined> {
  try {
    const value = await run()
    await clearIssue($, source)

    return value
  } catch (error) {
    await reportIssue($, source, error, after)

    return undefined
  }
}

async function reportIssue($: EngineInterface, source: IssueSource, error: unknown, after = 1) {
  const count = (misses.get(source) ?? 0) + 1
  misses.set(source, count)
  if (count < after) return
  const message = errorText(error)
  try {
    if (recordOf(await read($, issues))[source] !== message) {
      await update($, issues, value => ({ ...recordOf(value), [source]: message }))
    }
  } catch {
    // 連狀態都寫不進去，就只能放著
  }
}

async function clearIssue($: EngineInterface, source: IssueSource) {
  misses.delete(source)
  try {
    if (source in recordOf(await read($, issues))) {
      await update($, issues, value => Object.fromEntries(Object.entries(recordOf(value)).filter(([key]) => key !== source)))
    }
  } catch {
    // 同上
  }
}

// 錯誤的第一行，截短到面板放得下
function errorText(error: unknown): string {
  const text = error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string' ? error.message : String(error)
  const line = firstLine(text) || 'unknown error'

  return line.length <= MAX_ISSUE_CHARS ? line : `${line.slice(0, MAX_ISSUE_CHARS - 1)}…`
}

function firstLine(text: string): string {
  return (text.split('\n')[0] ?? '').trim()
}

// $.clock 出狀況時退回系統時間，時間相關的顯示照常
async function clockNow($: EngineInterface): Promise<number> {
  try {
    const now = await $.clock.now()
    if (Number.isFinite(now)) return now
  } catch {
    // 退回系統時間
  }

  return Date.now()
}

// 按鈕的處理常式：失敗時用 toast 說明，不讓錯誤丟回畫面
function press($: EngineInterface, what: string, run: () => Promise<unknown>): () => Promise<void> {
  return async () => {
    try {
      await run()
    } catch (error) {
      try {
        $.ui.toast(`Could not ${what}: ${errorText(error)}`)
      } catch {
        // 連 toast 都出不來就算了
      }
    }
  }
}

// 取一個值；失敗就用備用值，並把錯誤收進 failures
async function valueOr<T>(run: () => Promise<T>, fallback: T, failures: unknown[]): Promise<T> {
  try {
    return await run()
  } catch (error) {
    failures.push(error)

    return fallback
  }
}

// ---------- 整理狀態：舊版本存下或形狀不對的值當作空的，而不是讓面板出錯 ----------

function listOf<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : []
}

function recordOf<T>(value: Record<string, T> | null | undefined): Record<string, T> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function positive(value: unknown): number | undefined {
  const number = finite(value)

  return number !== undefined && number > 0 ? number : undefined
}

function isString(value: unknown): value is string {
  return typeof value === 'string'
}

function planOf(value: Plan | null | undefined): Plan {
  return { items: listOf(value?.items), planText: typeof value?.planText === 'string' ? value.planText : null }
}

function activityOf(value: Activity | null | undefined): Activity {
  return {
    running: listOf(value?.running),
    counts: recordOf(value?.counts),
    errors: finite(value?.errors) ?? 0,
    turnTools: finite(value?.turnTools) ?? 0,
    turnStartedAt: finite(value?.turnStartedAt),
    lastTurnMs: finite(value?.lastTurnMs),
  }
}

// ---------- 記錄 ----------

async function toggleSection($: EngineInterface, id: string) {
  const next = await update($, collapsed, list => {
    const ids = listOf(list).filter(isString)

    return ids.includes(id) ? ids.filter(one => one !== id) : [...ids, id]
  })
  // 存不進 $.store 只是下次不記得，這次照樣收合
  await attempt(() => $.store.set(COLLAPSED, next))
}

async function startTool($: EngineInterface, id: string, input: Fields) {
  const now = await clockNow($)
  const tool = String(input.tool)
  const entry: RunningTool = { id, tool, summary: toolSummary(input), startedAt: now }
  await update($, activity, value => {
    const current = activityOf(value)

    return {
      ...current,
      running: [...current.running.filter(one => one.id !== id), entry].slice(-8),
      counts: { ...current.counts, [tool]: (finite(current.counts[tool]) ?? 0) + 1 },
      turnTools: current.turnTools + 1,
    }
  })
}

async function endTool($: EngineInterface, id: string, hasFailed: boolean) {
  await update($, activity, value => {
    const current = activityOf(value)

    return {
      ...current,
      running: current.running.filter(one => one.id !== id),
      errors: current.errors + (hasFailed ? 1 : 0),
    }
  })
}

async function track($: EngineInterface, input: Fields, result: Fields | undefined) {
  switch (String(input.tool)) {
    case 'TodoWrite': {
      const todos = Array.isArray(input.todos) ? (input.todos as Fields[]) : []
      const items = todos.map((todo, index): PlanItem => ({
        id: `todo-${index}`,
        text: String(todo?.content ?? ''),
        active: typeof todo?.activeForm === 'string' ? todo.activeForm : undefined,
        status: planStatus(todo?.status) ?? 'pending',
      }))
      await update($, plan, value => ({ ...planOf(value), items }))

      return
    }
    case 'TaskCreate': {
      const task = result?.task as Fields | undefined
      if (typeof task?.id !== 'string') return
      const item: PlanItem = {
        id: task.id,
        text: String(task.subject ?? input.subject ?? ''),
        active: typeof input.activeForm === 'string' ? input.activeForm : undefined,
        status: 'pending',
      }
      await update($, plan, value => {
        const current = planOf(value)

        return { ...current, items: [...current.items.filter(one => one.id !== item.id), item] }
      })

      return
    }
    case 'TaskUpdate': {
      const id = String(input.taskId ?? '')
      await update($, plan, value => {
        const current = planOf(value)

        return {
          ...current,
          items:
            input.status === 'deleted'
              ? current.items.filter(one => one.id !== id)
              : current.items.map(one =>
                  one.id !== id
                    ? one
                    : {
                        ...one,
                        text: typeof input.subject === 'string' ? input.subject : one.text,
                        active: typeof input.activeForm === 'string' ? input.activeForm : one.active,
                        status: planStatus(input.status) ?? one.status,
                      },
                ),
        }
      })

      return
    }
    case 'TaskList': {
      const listed = Array.isArray(result?.tasks) ? (result.tasks as Fields[]) : null
      if (listed === null) return
      const items = listed.map((task): PlanItem => ({
        id: String(task?.id ?? ''),
        text: String(task?.subject ?? ''),
        status: planStatus(task?.status) ?? 'pending',
      }))
      await update($, plan, value => ({ ...planOf(value), items }))

      return
    }
    case 'ExitPlanMode': {
      if (typeof result?.plan === 'string' && result.plan.trim() !== '') {
        const planText = result.plan
        await update($, plan, value => ({ ...planOf(value), planText }))
      }

      return
    }
    case 'Edit':
    case 'Write': {
      const path = typeof result?.filePath === 'string' ? result.filePath : String(input.file_path ?? '')
      if (path === '') return
      const hunks = Array.isArray(result?.structuredPatch) ? (result.structuredPatch as Hunk[]) : []
      let added = 0
      let removed = 0
      for (const hunk of hunks) {
        for (const line of listOf(hunk?.lines)) {
          if (typeof line !== 'string') continue
          if (line.startsWith('+')) added += 1
          else if (line.startsWith('-')) removed += 1
        }
      }
      const isCreated = result?.type === 'create'
      // 新建的檔案沒有 hunks 時，以內容行數當作新增行數
      if (isCreated && hunks.length === 0 && typeof input.content === 'string') added = input.content.split('\n').length
      await recordChange($, path, added, removed, isCreated, hunks)

      return
    }
    case 'NotebookEdit': {
      const path = String(input.notebook_path ?? '')
      if (path !== '') await recordChange($, path, 0, 0, false, [])

      return
    }
    case 'Bash':
    case 'PowerShell': {
      // run_in_background，或逾時／Ctrl+B 被移到背景的指令都會帶 backgroundTaskId
      if (typeof result?.backgroundTaskId !== 'string') return
      const label = String(input.description || input.command || result.backgroundTaskId)
      await addTask($, { id: result.backgroundTaskId, kind: 'shell', label, status: 'running', startedAt: await clockNow($) })

      return
    }
    case 'Monitor': {
      if (typeof result?.taskId !== 'string') return
      const startedAt = await clockNow($)
      const timeoutMs = typeof result.timeoutMs === 'number' ? result.timeoutMs : 0
      await addTask($, {
        id: result.taskId,
        kind: 'monitor',
        label: String(input.description || result.taskId),
        status: 'running',
        startedAt,
        expiresAt: result.persistent === true || timeoutMs <= 0 ? undefined : startedAt + timeoutMs,
      })

      return
    }
    case 'TaskStop': {
      const id = result?.task_id ?? input.task_id ?? input.shell_id
      if (typeof id === 'string') await endTask($, id, 'killed')

      return
    }
  }
}

async function recordChange($: EngineInterface, path: string, added: number, removed: number, isCreated: boolean, hunks: Hunk[]) {
  const now = await clockNow($)
  const key = normalizeKey(path)
  await update($, changes, list => {
    const current = listOf(list)
    const before = current.find(one => one.key === key)
    const entry: FileChange = {
      key,
      path,
      added: (before?.added ?? 0) + added,
      removed: (before?.removed ?? 0) + removed,
      edits: (before?.edits ?? 0) + 1,
      created: before?.created ?? isCreated,
      lastAt: now,
      lastHunks: hunks.length > 0 ? limitHunks(hunks, KEEP_DIFF_LINES) : listOf(before?.lastHunks),
    }

    return [entry, ...current.filter(one => one.key !== key)].slice(0, MAX_FILES)
  })
}

async function readNotifications($: EngineInterface, text: string) {
  for (const match of text.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
    const body = match[1] ?? ''
    const id = /<task-id>([^<]+)<\/task-id>/.exec(body)?.[1]?.trim()
    const status = /<status>([^<]+)<\/status>/.exec(body)?.[1]?.trim()
    if (id && status) await endTask($, id, status)
  }
}

async function addTask($: EngineInterface, task: BgTask) {
  await update($, tasks, list => prune([...listOf(list).filter(one => one.id !== task.id), task], task.startedAt))
}

async function endTask($: EngineInterface, id: string, status: string) {
  const now = await clockNow($)
  await update($, tasks, list =>
    listOf(list).map(one => (one.id === id && one.endedAt === undefined ? { ...one, status, endedAt: now } : one)),
  )
}

// 每 5 秒與每回合結束：更新用量、標頭、背景任務與到期的監看，有工具執行中時推進 tick。
// 每個來源分開容錯，一個失敗不影響其他；內容沒變就不寫，免得面板一直重畫。
// 面板關著時什麼都不做：不輪詢、不跑 git；開啟時 openPane 會補一次完整更新
async function refresh($: EngineInterface) {
  if (!paneOpen) return
  const now = await clockNow($)
  const startedAt = await refreshUsage($, now)
  await refreshHeader($, startedAt)
  await refreshTasks($, now)

  // 編輯或指令結束後過了防抖時間才跑 git（每 5 秒檢查一次）
  if (gitDueAt !== 0 && now >= gitDueAt) {
    gitDueAt = 0
    await refreshGit($)
  }

  // 面板開著但 session id 換了（/clear）：替新 id 補寫 open 旗標
  if (paneOpen) {
    try {
      if ((await $.session.id()) !== flaggedId) await flagPane($, true)
    } catch {
      // 面板只是旁觀者
    }
  }
}

// 用量：訂閱制有 5 小時／每週額度；API key、Bedrock／Vertex、閘道按 token 計費時 rateLimits 是空的，
// cost 也可能沒有。拿到什麼記什麼，缺的欄位留空。回傳工作階段開始的時刻給標頭用
async function refreshUsage($: EngineInterface, now: number): Promise<number | undefined> {
  let startedAt: number | undefined
  await guard(
    $,
    'usage',
    async () => {
      const figures = await $.session.usage()
      if (figures === null || typeof figures !== 'object') throw new Error('no usage figures returned')
      startedAt = positive(figures.startedAt)
      const nextUsage = usageFrom(figures, now)
      const currentUsage = await read($, usage)
      if (JSON.stringify(currentUsage) !== JSON.stringify(nextUsage)) await update($, usage, () => nextUsage)
    },
    POLL_MISSES,
  )

  return startedAt
}

// 把 $.session.usage() 整理成面板用的形狀；欄位缺漏或型別不對就當作沒有，不丟錯
function usageFrom(figures: SessionUsage, now: number): Usage {
  const tokens = finite(figures.context?.tokens)
  const window = positive(figures.context?.window)
  const limits = listOf(figures.rateLimits).flatMap((limit): UsageLimit[] => {
    const percent = finite(limit?.percentUsed)
    if (typeof limit?.kind !== 'string' || percent === undefined) return []

    return [{ kind: limit.kind, percent, resetsAt: typeof limit.resetsAt === 'string' ? limit.resetsAt : undefined }]
  })

  return {
    contextPercent: finite(figures.context?.percent) ?? (tokens !== undefined && window !== undefined ? Math.round((tokens / window) * 100) : undefined),
    contextTokens: tokens,
    contextWindow: window,
    limits,
    costUsd: finite(figures.cost?.usd),
    minute: Math.floor(now / 60_000),
  }
}

// 標頭的欄位分開取：哪個失敗就沿用上一次的值（沒有就留空），其他欄位照常更新
async function refreshHeader($: EngineInterface, startedAt: number | undefined) {
  const failures: unknown[] = []
  try {
    const before = await read($, header).catch(() => null)
    const root = await valueOr(() => $.session.root(), before?.root ?? '', failures)
    const nextHeader: Header = {
      model: await valueOr(() => $.session.model(), before?.model ?? '', failures),
      root,
      // 取不到 cwd 就用 root，不算錯
      cwd: await valueOr(() => $.session.cwd(), root, []),
      startedAt: startedAt ?? before?.startedAt,
      turns: await valueOr<number | undefined>(() => $.session.turns(), before?.turns, failures),
    }
    if (JSON.stringify(before) !== JSON.stringify(nextHeader)) await update($, header, () => nextHeader)
  } catch (error) {
    failures.push(error)
  }
  await (failures.length === 0 ? clearIssue($, 'header') : reportIssue($, 'header', failures[0], POLL_MISSES))
}

// 背景任務：併入子代理清單、標記逾時的監看、清掉太舊的。子代理清單取不到時，其他照做
async function refreshTasks($: EngineInterface, now: number) {
  const failures: unknown[] = []
  let agents: AgentInfo[] = []
  try {
    const listed = await $.agent.list()
    if (!Array.isArray(listed)) throw new Error('no agent list returned')
    agents = listed
  } catch (error) {
    failures.push(error)
  }
  try {
    const current = listOf(await read($, tasks))
    const byId = new Map(current.map(task => [task.id, task]))
    for (const agent of agents) {
      const before = byId.get(agent.id)
      const status = String(agent.status ?? 'running')
      const isEnded = ENDED.has(status)
      byId.set(agent.id, {
        id: agent.id,
        kind: 'agent',
        label: String(agent.description || agent.name || agent.type || agent.id),
        status,
        startedAt: before?.startedAt ?? now,
        endedAt: isEnded ? (before?.endedAt ?? now) : undefined,
      })
    }
    for (const [id, task] of byId) {
      if (task.endedAt === undefined && task.expiresAt !== undefined && task.expiresAt <= now) {
        byId.set(id, { ...task, status: 'expired', endedAt: task.expiresAt })
      }
    }
    const nextTasks = prune([...byId.values()], now)
    if (JSON.stringify(current) !== JSON.stringify(nextTasks)) await update($, tasks, () => nextTasks)
  } catch (error) {
    failures.push(error)
  }
  await (failures.length === 0 ? clearIssue($, 'agents') : reportIssue($, 'agents', failures[0], POLL_MISSES))

  // 有工具執行中時推進 tick，讓經過秒數跟著更新
  await attempt(async () => {
    if (activityOf(await read($, activity)).running.length > 0) await update($, tick, value => (finite(value) ?? 0) + 1)
  })
}

// 面板畫出來了：記下、寫旗標、立刻把所有來源更新一遍（關著的期間沒有輪詢）
async function openPane($: EngineInterface) {
  openTimer?.cancel()
  openTimer = undefined
  paneOpen = true
  await flagPane($, true)
  await refreshAll($)
}

// 面板關了：之後不輪詢、不跑 git；旗標改回 closed
async function closePane($: EngineInterface) {
  openTimer?.cancel()
  openTimer = undefined
  paneOpen = false
  await flagPane($, false)
}

async function refreshAll($: EngineInterface) {
  await refresh($)
  await refreshGit($)
  await refreshContext($)
}

// 更新這個工作階段的旗標檔
async function flagPane($: EngineInterface, isOpen: boolean) {
  try {
    if (!isOpen) {
      await writeFlag($, flaggedId, 'closed')
      flaggedId = ''

      return
    }
    const id = await $.session.id()
    if (flaggedId !== '' && flaggedId !== id) await writeFlag($, flaggedId, 'closed')
    await writeFlag($, id, 'open')
    flaggedId = id
  } catch {
    // 寫不了旗標，狀態列就照常顯示
  }
}

// 查旗標資料夾 ~/.claude/desk-panel/open 在不在：使用者自己建立才表示狀態列會讀，才寫旗標；沒有就什麼都不寫
async function checkFlagRoot($: EngineInterface): Promise<string | null> {
  try {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
    if (home === undefined) return (flagRoot = null)
    const dir = `${home.replace(/\\/g, '/')}/.claude/desk-panel/open`

    return (flagRoot = (await $.fs.exists(dir)) ? dir : null)
  } catch {
    return (flagRoot = null)
  }
}

// 狀態列腳本讀 ~/.claude/desk-panel/open/<session id>：內容是 open 就不輸出（沒有刪檔 API，所以用內容表示）
async function writeFlag($: EngineInterface, id: string, state: 'open' | 'closed') {
  if (id === '') return
  const dir = flagRoot === undefined ? await checkFlagRoot($) : flagRoot
  if (dir === null) return
  await $.fs.write(`${dir}/${id}`, state)
}

// 跑 git 並回傳 stdout。必要的指令（isRequired）失敗時丟出 git 自己的訊息（例如 dubious ownership）；
// 其餘的失敗（沒有 upstream、還沒有 commit）回空字串
async function runGit($: EngineInterface, root: string, args: string[], isRequired = false): Promise<string> {
  const out = await $.process.run(['git', '-C', root, '-c', 'core.quotePath=false', '--no-optional-locks', ...args], { timeoutMs: 5000 })
  if (out.exitCode === 0) return String(out.stdout ?? '')
  if (isRequired) throw new Error(firstLine(String(out.stderr ?? '')) || `git ${args[0] ?? ''} exited with code ${out.exitCode}`)

  return ''
}

// branch、ahead/behind、未 commit 的檔案（含 numstat）、最後一個 commit、這個工作階段的 commit。
// git 不在 PATH、逾時、repo 讀不了等：保留上一次的結果，Git 區塊標出原因。
// 同時只跑一份：跑到一半又被叫到就記下，跑完再跑一次
async function refreshGit($: EngineInterface) {
  if (gitRunning) {
    gitAgain = true

    return
  }
  gitRunning = true
  try {
    await runGitRefresh($)
  } finally {
    gitRunning = false
  }
  if (gitAgain) {
    gitAgain = false
    await refreshGit($)
  }
}

async function runGitRefresh($: EngineInterface) {
  try {
    const repo = await $.session.repo()
    if (repo === null) {
      if ((await read($, git)) !== null) await update($, git, () => null)
      await clearIssue($, 'git')

      return
    }
    if (typeof repo?.root !== 'string') throw new Error('the session did not report its repository')
    const root = repo.root.replace(/\\/g, '/').replace(/\/+$/, '')
    // status 讀不了代表整個 repo 都讀不了，用它的錯誤訊息
    const status = await runGit($, root, ['status', '--porcelain=v1', '-uall'], true)
    const branch = (await runGit($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || '(no commits yet)'
    const counts = (await runGit($, root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'])).trim().split(/\s+/)
    const numstat = parseNumstat(await runGit($, root, ['diff', 'HEAD', '--numstat']))
    // 清單只存前 MAX_GIT_FILES 筆，免得大 repo 的狀態膨脹；總數另外記
    const allFiles = parsePorcelain(status, root, numstat)
    const files = allFiles.slice(0, MAX_GIT_FILES)
    const last = parseLog(await runGit($, root, ['log', '-1', '--format=%h%x1f%s%x1f%ct']))[0]
    const startedAt = positive((await read($, header).catch(() => null))?.startedAt)
    const sessionCommits = startedAt
      ? parseLog(await runGit($, root, ['log', `--since=@${Math.floor(startedAt / 1000)}`, '--format=%h%x1f%s%x1f%ct'])).slice(0, MAX_SESSION_COMMITS)
      : []
    const nextGit: GitInfo = {
      root,
      branch,
      ahead: counts.length === 2 ? finite(Number(counts[1])) : undefined,
      behind: counts.length === 2 ? finite(Number(counts[0])) : undefined,
      files,
      fileCount: allFiles.length,
      last,
      sessionCommits,
    }
    await clearIssue($, 'git')
    const current = await read($, git)
    if (JSON.stringify(current) === JSON.stringify(nextGit)) return
    await update($, git, () => nextGit)
    // 檔案內容可能變了：清掉快取的 diff，正在展開的那個重新取
    await update($, gitDiffs, () => ({}))
    const open = await read($, expanded)
    const shown = open?.startsWith('git:') ? files.find(file => `git:${file.key}` === open) : undefined
    if (shown !== undefined) await loadGitDiff($, shown)
  } catch (error) {
    await reportIssue($, 'git', error)
  }
}

// 取不到 diff 時記成 null，面板顯示「無法取得」而不是一直「載入中」
async function loadGitDiff($: EngineInterface, file: GitFile) {
  const repo = await read($, git).catch(() => null)
  if (repo === null || file.status === '?') return
  let hunks: Hunk[] | null
  try {
    hunks = limitHunks(parseUnifiedDiff(await runGit($, repo.root, ['diff', 'HEAD', '--', file.path])), KEEP_DIFF_LINES)
  } catch {
    hunks = null
  }
  await update($, gitDiffs, value => ({ ...recordOf(value), [file.key]: hunks }))
}

// /context 的類別（本機估算，不呼叫 token 計數 API）
async function refreshContext($: EngineInterface) {
  await guard($, 'context', async () => {
    const breakdown = (await $.session.usage({ breakdown: 'summary' }))?.context?.breakdown
    // 工作階段還沒綁定時沒有 breakdown：保留上一次的
    if (!breakdown) return
    const nextContext: ContextInfo = {
      slices: listOf(breakdown.categories)
        .filter(category => (finite(category?.tokens) ?? 0) > 0)
        .map(category => ({ name: String(category.name), tokens: category.tokens, color: String(category.color), kind: String(category.kind) })),
      total: finite(breakdown.totalTokens) ?? 0,
      max: finite(breakdown.maxTokens) ?? 0,
    }
    const current = await read($, context)
    if (JSON.stringify(current) !== JSON.stringify(nextContext)) await update($, context, () => nextContext)
  })
}

function prune(list: BgTask[], now: number): BgTask[] {
  const running = list.filter(task => task.endedAt === undefined)
  const finished = list
    .filter(task => task.endedAt !== undefined && now - task.endedAt < FINISHED_TTL_MS)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))
    .slice(0, KEEP_FINISHED)

  return [...running, ...finished]
}

// ---------- 解析 ----------

// 正斜線；Windows 路徑（磁碟代號或 UNC）不分大小寫所以小寫，其他系統的路徑保留大小寫
function normalizeKey(path: string): string {
  const slashed = path.replace(/\\/g, '/')

  return /^([a-z]:|\/\/)/i.test(slashed) ? slashed.toLowerCase() : slashed
}

function parseNumstat(text: string): Map<string, { added?: number; removed?: number }> {
  const counts = new Map<string, { added?: number; removed?: number }>()
  for (const line of text.split('\n')) {
    const [added, removed, ...rest] = line.replace(/\r$/, '').split('\t')
    if (added === undefined || removed === undefined || rest.length === 0) continue
    // 改名寫成 "old => new" 或 "dir/{old => new}/x"，取新路徑
    const path = rest.join('\t').replace(/\{[^}]* => ([^}]*)\}/, '$1').replace(/^.* => /, '')
    counts.set(path, { added: added === '-' ? undefined : Number(added), removed: removed === '-' ? undefined : Number(removed) })
  }

  return counts
}

function parsePorcelain(text: string, root: string, numstat: Map<string, { added?: number; removed?: number }>): GitFile[] {
  const files: GitFile[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    const path = (line.slice(3).split(' -> ').pop() ?? '').replace(/^"|"$/g, '')
    const status = code === '??' ? '?' : (code.trim()[0] ?? '?')
    const counts = numstat.get(path)
    files.push({ key: normalizeKey(`${root}/${path}`), path, status, added: counts?.added, removed: counts?.removed })
  }

  return files
}

function parseLog(text: string): GitCommit[] {
  return text
    .split('\n')
    .map(line => line.replace(/\r$/, '').split('\x1f'))
    .filter(parts => parts.length === 3)
    .map(([hash, subject, seconds]) => ({ hash: hash ?? '', subject: subject ?? '', at: Number(seconds) * 1000 }))
}

function parseUnifiedDiff(text: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const start = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (start !== null) {
      current = {
        oldStart: Number(start[1]),
        oldLines: Number(start[2] ?? '1'),
        newStart: Number(start[3]),
        newLines: Number(start[4] ?? '1'),
        lines: [],
      }
      hunks.push(current)
    } else if (line.startsWith('diff --git')) {
      current = undefined
    } else if (current !== undefined && /^[ +\-\\]/.test(line)) {
      current.lines.push(line)
    }
  }

  return hunks
}

// ---------- 顯示 ----------

function planStatus(value: unknown): PlanStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined
}

function toolSummary(input: Fields): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.trim() !== '') return value.trim().split('\n')[0] ?? ''
    }

    return ''
  }
  switch (String(input.tool)) {
    case 'Bash':
    case 'PowerShell':
      return pick('description', 'command')
    case 'Read':
    case 'Edit':
    case 'Write':
      return baseName(pick('file_path'))
    case 'NotebookEdit':
      return baseName(pick('notebook_path'))
    case 'Grep':
    case 'Glob':
      return pick('pattern')
    case 'WebFetch':
      return pick('url')
    case 'WebSearch':
      return pick('query')
    case 'Agent':
      return pick('description')
    default:
      return ''
  }
}

// effort 是等級（max）或數字
function effortText(level: string): string {
  return /^\d+(\.\d+)?$/.test(level) ? `effort ${level}` : `${level} effort`
}

// 截短 hunks 但維持 @@ 標頭的行數正確，Code 的 diff 格式才解析得了
function limitHunks(hunks: Hunk[], maxLines: number): Hunk[] {
  const out: Hunk[] = []
  let used = 0
  for (const hunk of hunks) {
    const room = maxLines - used - 1
    if (room <= 0) break
    const lines = listOf(hunk?.lines).slice(0, room)
    out.push({
      oldStart: hunk.oldStart,
      oldLines: lines.filter(line => line.startsWith(' ') || line.startsWith('-')).length,
      newStart: hunk.newStart,
      newLines: lines.filter(line => line.startsWith(' ') || line.startsWith('+')).length,
      lines,
    })
    used += lines.length + 1
  }

  return out
}

function diffText(hunks: Hunk[], maxLines: number): string {
  return limitHunks(hunks, maxLines)
    .map(hunk => [`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...hunk.lines].join('\n'))
    .join('\n')
}

// 依 token 比例切成彩色段：已用 █、壓縮緩衝 ▒、可用 ░
function contextBar(ctx: ContextInfo, cells: number): { text: string; color: string }[] {
  const max = Math.max(ctx.max, 1)
  const order = [
    ...ctx.slices.filter(slice => slice.kind === 'used' || slice.kind === 'deferred'),
    ...ctx.slices.filter(slice => slice.kind === 'buffer'),
    ...ctx.slices.filter(slice => slice.kind === 'free'),
  ]
  const segments: { text: string; color: string }[] = []
  let used = 0
  for (const slice of order) {
    const size = Math.min(cells - used, Math.round((slice.tokens / max) * cells))
    if (!(size > 0)) continue
    const glyph = slice.kind === 'free' ? '░' : slice.kind === 'buffer' ? '▒' : '█'
    segments.push({ text: glyph.repeat(size), color: slice.color })
    used += size
  }
  if (used < cells) segments.push({ text: '░'.repeat(cells - used), color: 'inactive' })

  return segments
}

function tokensText(tokens: number): string {
  if (tokens < 1000) return `${tokens}`

  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`
}

function baseName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

function relativePath(path: string, root: string | undefined): string {
  const slashed = path.replace(/\\/g, '/')
  if (root === undefined) return slashed
  const base = root.replace(/\\/g, '/').replace(/\/+$/, '')

  return slashed.toLowerCase().startsWith(`${base.toLowerCase()}/`) ? slashed.slice(base.length + 1) : slashed
}

function shortPath(path: string, room: number): string {
  return path.length <= room ? path : `…${path.slice(-(room - 1))}`
}

function shortText(text: string, room: number): string {
  return text.length <= room ? text : `${text.slice(0, room - 1)}…`
}

function bar(percent: number | undefined, cells: number): string {
  const filled = percent === undefined ? 0 : Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)

  return '█'.repeat(filled) + '░'.repeat(cells - filled)
}

function levelColor(percent: number | undefined): string {
  if (percent === undefined) return 'inactive'
  if (percent >= 80) return 'error'
  if (percent >= 50) return 'warning'

  return 'success'
}

// 「24k / 200k tokens」；不知道 window 時只寫用了多少
function contextNote(u: Usage): string {
  const tokens = finite(u.contextTokens)
  if (tokens === undefined) return ''
  const window = positive(u.contextWindow)

  return window === undefined ? `${Math.round(tokens / 1000)}k tokens` : `${Math.round(tokens / 1000)}k / ${Math.round(window / 1000)}k tokens`
}

function taskIcon(task: BgTask): string {
  if (task.endedAt === undefined) return '●'
  if (task.status === 'completed') return '✓'
  if (task.status === 'failed') return '✗'

  return '■'
}

function taskColor(task: BgTask): string {
  if (task.endedAt === undefined) return 'warning'
  if (task.status === 'completed') return 'success'
  if (task.status === 'failed') return 'error'

  return 'inactive'
}

function durationText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (!Number.isFinite(minutes)) return '—'
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)

  return `${hours}h ${minutes % 60}m`
}

// 秒級的經過時間：執行中的工具、回合耗時
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

// 照官方 /usage 的「Resets 3:50pm (Asia/Taipei)」「Resets Oct 27, 9am (Asia/Taipei)」：
// 24 小時內只寫時刻、整點不寫分鐘、am/pm 小寫緊貼，跨年才加年份，最後附時區
function resetText(iso: string, now: number, alwaysShowDate: boolean): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return ''
  const lowerAmPm = (text: string) => text.replace(/[  ]([AP]M)/i, (_, half: string) => half.toLowerCase())
  const minute = at.getMinutes() === 0 ? undefined : '2-digit'
  try {
    let when: string
    if (alwaysShowDate || (at.getTime() - now) / 3_600_000 > 24) {
      const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute, hour12: true }
      if (at.getFullYear() !== new Date(now).getFullYear()) options.year = 'numeric'
      when = lowerAmPm(at.toLocaleString('en-US', options))
    } else {
      when = lowerAmPm(at.toLocaleTimeString('en-US', { hour: 'numeric', minute, hour12: true }))
    }
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone

    return `Resets ${when}${zone ? ` (${zone})` : ''}`
  } catch {
    // 沒有 Intl 時退回相對時間
    const minutes = Math.max(0, Math.ceil((at.getTime() - now) / 60_000))

    return `Resets in ${Math.floor(minutes / 60)}h ${minutes % 60}m`
  }
}
