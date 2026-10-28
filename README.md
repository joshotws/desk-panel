# desk-panel

繁體中文 · [English](README.en.md)

給 [Claude Code](https://code.claude.com/docs) 終端機用的側邊面板，版面對應 Claude desktop app 的右側面板：計畫、Claude 改過的檔案、背景任務與 subagent、用量和 git 集中在同一個面板，而且可以直接操作，例如展開檔案看 diff、切去看 subagent 的對話、開 `/diff`。訂閱制和按 token 計費（API key、Bedrock、Vertex、閘道）的用量都能正確顯示；某個資料來源出錯只影響它自己的區塊；面板關著時不輪詢，也不跑 git。

這是獨立專案，與 Anthropic 無關，也未經其背書。

![desk-panel：停靠在終端機右側的 Session 面板](docs/desk-panel.png)

<sub>示意圖由 OpenAI gpt-image-2 產生（prompt 在 [`docs/desk-panel-prompt.txt`](docs/desk-panel-prompt.txt)），不是實際截圖，細節以實際畫面為準。</sub>

輸入 `/panel`，對話旁邊會開一個標題為 *Session* 的面板，由上而下：

| 區塊 | 內容 |
| --- | --- |
| 標頭 | 模型；最近一次請求的 effort、工作階段已進行多久、回合數；目前所在的資料夾與 branch |
| Plan | TodoWrite／Task 工具的待辦與進度（`2/5`）、ExitPlanMode 核准的計畫 |
| Changes | 這個工作階段 Claude 改過的檔案（`+增 −減`、幾分鐘前），再列 git 裡其他未 commit 的檔案。點檔名展開最近一次的 diff；`Open /diff` 開內建的 diff 畫面 |
| Background tasks | 背景指令、Monitor、subagent；點 subagent 切去看它的對話 |
| Usage | Context、*Current session*、*Current week*、*Spend limit* 長條與重設時間（格式同 `/usage`）；估算的花費（見下方） |
| Git | branch、ahead/behind、未 commit 檔案數、最後一個 commit 或本工作階段的 commit |
| Activity（預設收合） | 執行中的工具與秒數、本回合工具數、上回合耗時、各工具次數與錯誤數 |
| Context（預設收合） | 類似 `/context` 的分色長條與最大的幾個類別 token 數 |

點區塊標題可以收合或展開，收合狀態跨工作階段記住。

## 需求

- 支援 hooks-module plugin API 的 Claude Code。在 Claude Code 2.1.312 上測試過。這組 API 仍是 early access，版本之間可能變動，新版本可能需要更新這個 mod。
- 畫在哪裡：終端機的 fullscreen 版面時停靠右側（要求 52 欄，引擎會限制在 24 欄到終端寬度的 45%）；非 fullscreen 版面時顯示在 prompt 上方；desktop app 的 Code 分頁也會畫。
- Git 區塊需要 `PATH` 上有 `git`（沒有的話區塊顯示 git 的錯誤訊息）。
- 終端字型要有常見的方塊與箭頭字元（`▾ ▸ ✓ ● █ ░ ⚠`）。

## 安裝

在終端機的工作階段裡，於 prompt 輸入：

```
/plugin install desk-panel --marketplace joshotws/desk-panel
```

或在 shell 執行：

```bash
claude plugin install desk-panel --marketplace joshotws/desk-panel
```

desktop app 不能跑 `/plugin`：按 prompt 框旁邊的 **+**，選 **Plugins**，**Add marketplace** 輸入 `joshotws/desk-panel`，再 **Add plugin**。

安裝時會先問 `Add marketplace?`（來源是 `github:joshotws/desk-panel`，回 `y`），再選 scope（第一個是 user scope，按 Enter）。看到 `Installed desk-panel. Plugin is now active.` 之後，這個工作階段與之後的每個工作階段都會載入。

## 指令與操作

| 指令 | 作用 |
| --- | --- |
| `/panel` | 開啟面板；之後新工作階段會自動開 |
| `/panel close` | 關閉，並取消自動開啟；自己按關閉面板也一樣 |
| `/panel reset` | 恢復預設版面（Activity、Context 收合，其餘展開）、清掉警告、重新取一次所有資料 |
| `/panel size` | 回報面板最近一次畫出來的大小，除錯用 |

工作階段自動開啟面板時若終端太窄，面板會等到視窗夠寬才畫出來，畫出來的當下會更新資料。

## Usage 與花費

訂閱制的回應帶有 5 小時與每週額度，長條與 `/usage` 一致。用 API key、Bedrock、Vertex 或按 token 計費的閘道時，回應沒有方案額度：區塊標 `API billing`，寫 `Plan limits: none (billed per token via API)`，花費標成 `pay-as-you-go`（訂閱制則是 `API pricing`）。

**`Total cost` 是估算，不是帳單。** 它是 Claude Code 自己算的數字，和 `/cost` 相同：每次回應的 token 數乘上 Anthropic 的牌價。透過閘道調用時，實際收費以閘道的計價為準；Claude Code 算不出價格時（例如閘道後面是非 Claude 的模型），花費是 0 或沒有，這一行就不顯示。

重設時間用 en-US 的 12 小時制與本機時區，和 `/usage` 一樣。

## 這個 mod 會寫什麼、跑什麼

資料不會離開你的電腦：mod 不連網，也不送任何遙測。

- **plugin 的 store**：兩個鍵（`autoOpen`、`collapsed`），存在 Claude Code 設定目錄下這個 plugin 自己的 JSON 檔。
- **旗標檔（選用）**：`~/.claude/desk-panel/open/<session id>`，內容是 `open` 或 `closed`。只有你自己建立了 `~/.claude/desk-panel/open/` 這個資料夾才會寫（工作階段開始與 `/panel` 時檢查），見下一節。家目錄在 Windows 用 `USERPROFILE`，其他系統用 `HOME`。
- **git**（唯讀）在工作階段的 repo 裡執行，每次都帶 `--no-optional-locks`、5 秒逾時：`status --porcelain=v1 -uall`、`rev-parse --abbrev-ref HEAD`、`rev-list --left-right --count @{upstream}...HEAD`、`diff HEAD --numstat`、`log -1`、`log --since=<工作階段開始>`，以及展開檔案時的 `diff HEAD -- <file>`。狀態裡最多存 100 個檔案，總數照實顯示。
- **面板開著時**：每 5 秒輪詢用量、標頭、subagent 清單；Edit／Write／NotebookEdit／Bash／PowerShell 結束後約 2 秒以及每回合結束時跑 git；每回合結束時更新 context 分類。**面板關著時**不輪詢、不跑 git；工具呼叫、計畫、改過的檔案、活動與背景任務照常記錄，開啟時就有這個工作階段的歷史。

## 選用：面板開著時隱藏狀態列

面板上已經有狀態列通常會顯示的資訊。想讓狀態列在面板開著時消失，先建立旗標資料夾：

```bash
mkdir -p ~/.claude/desk-panel/open
```

之後 mod 會在 `~/.claude/desk-panel/open/<session id>` 寫入 `open` 或 `closed`。狀態列指令的 JSON 輸入裡有 session id，讀到 `open` 就直接結束：

```bash
#!/bin/bash
input=$(cat)
id=$(printf '%s' "$input" | jq -r '.session_id')
[ "$(cat "$HOME/.claude/desk-panel/open/$id" 2>/dev/null)" = "open" ] && exit 0
# ... 下面接你原本的狀態列
```

狀態列不是即時重畫：開關面板後要等它下一次更新才會消失或出現。檔案不會被刪除（沒有刪檔 API，關閉時寫 `closed`），想清就整個資料夾清掉。沒有這個資料夾，mod 什麼都不寫。

## 容錯

- 每個區塊各自容錯。資料來源失敗（用量、模型名稱、subagent 清單、git、context 分類）時，只有對應的區塊標出 `⚠` 與原因，上一次的資料繼續顯示；輪詢的來源連續失敗兩次才標，恢復後自動消失。
- git 讀不了 repo（不在 `PATH`、逾時、`safe.directory`）時，Git 區塊顯示 git 自己的訊息；取不到的 diff 顯示 `(diff unavailable)`。
- 區塊畫不出來（例如舊版本留下的狀態）時顯示 `⚠ could not draw this section`；整個面板都畫不出來時顯示原因與復原方式（`/panel reset`、`/reload-plugins`）。
- 按鈕的動作失敗時用 toast 說明；`/panel` 指令失敗時回覆原因。

## 開發

這個 repo 是只含一個 plugin 的 marketplace，mod 本體在 [`desk-panel/`](desk-panel)。

```bash
git clone https://github.com/joshotws/desk-panel
cd desk-panel
claude --plugin-dir ./desk-panel
```

在互動的工作階段裡從資料夾載入 mod，引擎會把 API 型別寫到 `desk-panel/.claude-plugin/types/`（git 已忽略；`desk-panel/tsconfig.json` 就是 extends 那裡的 `tsconfig.json`）。第一次載入之前，編輯器會找不到 `claude-code` 模組。存檔後該工作階段會重新載入 mod。要改用安裝的方式跑，把 clone 下來的資料夾加成 marketplace（`claude plugin marketplace add /path/to/desk-panel`，再 `claude plugin install desk-panel@desk-panel`）：資料夾型 marketplace 直接讀原資料夾，改完 `/reload-plugins` 就生效。

commit 之前：

```bash
claude plugin validate desk-panel   # 引擎會不會拒絕，以及模組 hook 了什麼、呼叫了什麼
claude plugin test desk-panel       # 用引擎跑 desk-panel/tests/*.test.tsx
npx -p typescript tsc -p desk-panel # 型別檢查 hooks、types 與 tests
```

引擎的靜態掃描要求 `read($, atom)`、`update($, atom, ...)` 在呼叫處直接寫出 atom 常數，不要包成輔助函式。`desk-panel/types/index.d.ts` 是這個 mod 的狀態契約。

## 移除

在 `/plugin` 裡暫時關掉，或整個移除：

```bash
claude plugin uninstall desk-panel@desk-panel
```

有建立旗標資料夾的話，把 `~/.claude/desk-panel/` 刪掉即可。

## 已知限制

- hooks-module API 是 early access；Claude Code 更新後 mod 可能失效，要等更新。
- `git status -uall` 會列出每一個未追蹤的檔案（已忽略的除外），未追蹤的檔案很多時會慢。
- 檔案的比對鍵在 Windows 路徑不分大小寫，其他系統分大小寫。
- 時間格式固定 en-US，和 `/usage` 一樣。

## 貢獻

歡迎開 issue 或 pull request。送出前請跑 `claude plugin validate`、`claude plugin test` 與 `tsc`。程式註解是繁體中文，新寫的用英文也可以。

## 授權與免責

[MIT](LICENSE)。

這是獨立專案，與 Anthropic 無關，也未經其背書。Claude 與 Claude Code 是 Anthropic, PBC 的商標。面板版面仿照 Claude desktop app 的側邊面板。上方示意圖、GitHub social preview（`docs/social-preview.png`）與 plugin 圖示都由 OpenAI gpt-image-2 產生，prompt 放在 [`docs/`](docs)。
