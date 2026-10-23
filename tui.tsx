// DeepSeek 余额侧边栏插件
// 数据来源: GET https://api.deepseek.com/user/balance
// 认证方式: Authorization: Bearer <apiKey>
// API Key 获取优先级:
//   1. 环境变量 DEEPSEEK_API_KEY
//   2. 当前 DeepSeek provider 的 apiKey（全局/项目 opencode.json(c)）
// 显示条件: 当前模型 ID 或 provider ID 含 deepseek
// 显示位置: sidebar.content 顶部
// 会话开销: 按每条 assistant/compaction 消息的 token 与 DeepSeek 官方单价估算
// 今日开销: 读取 OpenCode session.stats，按北京时间当天和峰谷价估算

import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createEffect, createMemo, createSignal } from "solid-js"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  type Currency,
  type StatsSnapshot,
  calculateUsageCost,
  ensureModel,
  isEmptyUsage,
  mergeStats,
  normalizeStats,
  peakWindows,
  priceFor,
  startOfBeijingDay,
  subtractStats,
  tokensCost,
  toNumber,
} from "./usage"

type BalanceInfo = {
  currency?: string
  total_balance?: string
  granted_balance?: string
  topped_up_balance?: string
}

type BalanceResponse = {
  is_available?: boolean
  balance_infos?: BalanceInfo[]
}

type NormalizedBalanceInfo = {
  currency: Currency
  total: number
  granted: number
  toppedUp: number
}

type BalanceState = {
  isAvailable: boolean
  infos: NormalizedBalanceInfo[]
  fetchedAt: number
}

type ProviderConfig = {
  apiKey?: string
  baseURL?: string
}

type ProviderEntry = {
  id: string
  options: Record<string, any>
  raw: Record<string, any>
}

const DEFAULT_BALANCE_URL = "https://api.deepseek.com/user/balance"
const REFRESH_MS = 5 * 60 * 1000
const IDLE_THROTTLE_MS = 60 * 1000
const REQUEST_TIMEOUT_MS = 10 * 1000
const STATS_TIMEZONE = "Asia/Shanghai"

const MONEY_FORMATTER = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
})

class HttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`HTTP ${status}`)
    this.status = status
  }
}

function stripJsonc(input: string): string {
  let output = ""
  let inString = false
  let inLineComment = false
  let inBlockComment = false
  let escaped = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]
    const next = input[index + 1]

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false
        output += char
      }
      continue
    }

    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false
        index += 1
      }
      continue
    }

    if (inString) {
      output += char
      if (escaped) {
        escaped = false
      } else if (char === "\\") {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
      output += char
      continue
    }

    if (char === "/" && next === "/") {
      inLineComment = true
      index += 1
      continue
    }

    if (char === "/" && next === "*") {
      inBlockComment = true
      index += 1
      continue
    }

    output += char
  }

  return output.replace(/,\s*([}\]])/g, "$1")
}

function readJsonc(file: string): any | undefined {
  try {
    if (!fs.existsSync(file)) return undefined
    return JSON.parse(stripJsonc(fs.readFileSync(file, "utf8")))
  } catch {
    return undefined
  }
}

function resolveApiKeyValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (!trimmed) return undefined
    const template =
      trimmed.match(/^\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/) ??
      trimmed.match(/^\{env:([^}]+)\}$/)
    if (template) return process.env[template[1]]?.trim() || undefined
    return trimmed
  }

  if (value && typeof value === "object" && "env" in value) {
    const name = (value as { env?: unknown }).env
    if (typeof name === "string") return process.env[name]?.trim() || undefined
  }

  return undefined
}

function configFiles(directory?: string): string[] {
  const configBase = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  const globalDir = path.join(configBase, "opencode")
  const files: string[] = []

  if (directory) {
    files.push(
      path.join(directory, "opencode.json"),
      path.join(directory, "opencode.jsonc"),
      path.join(directory, ".opencode", "opencode.json"),
      path.join(directory, ".opencode", "opencode.jsonc"),
    )
  }

  files.push(path.join(globalDir, "opencode.json"), path.join(globalDir, "opencode.jsonc"))
  return files
}

function providerEntries(config: any): ProviderEntry[] {
  if (!config || typeof config !== "object") return []
  const providers = {
    ...(config.providers && typeof config.providers === "object" ? config.providers : {}),
    ...(config.provider && typeof config.provider === "object" ? config.provider : {}),
  }

  return Object.entries(providers).map(([id, value]) => {
    const raw = value && typeof value === "object" ? (value as Record<string, any>) : {}
    const options =
      raw.options && typeof raw.options === "object" ? (raw.options as Record<string, any>) : {}
    return { id, options, raw }
  })
}

function resolveProviderConfig(context: any, model: any): ProviderConfig {
  const envKey = resolveApiKeyValue(process.env.DEEPSEEK_API_KEY)
  if (envKey) {
    return {
      apiKey: envKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    }
  }

  const entries: ProviderEntry[] = []
  for (const file of configFiles(context?.location?.directory)) {
    const config = readJsonc(file)
    if (config) entries.push(...providerEntries(config))
  }

  const candidates = entries
    .map((entry) => {
      const baseURL = String(entry.options.baseURL ?? entry.raw.baseURL ?? "")
      const apiKey = resolveApiKeyValue(entry.options.apiKey ?? entry.raw.apiKey)
      return {
        id: entry.id,
        baseURL,
        apiKey,
        official: baseURL.includes("api.deepseek.com"),
        named: /deepseek/i.test(entry.id),
      }
    })
    .filter((entry) => entry.apiKey)

  const currentID = model?.providerID
  const current = candidates.find((entry) => entry.id === currentID)
  if (current) return { apiKey: current.apiKey, baseURL: current.baseURL }

  const official = candidates.find((entry) => entry.official)
  if (official) return { apiKey: official.apiKey, baseURL: official.baseURL }

  const named = candidates.find((entry) => entry.named)
  if (named) return { apiKey: named.apiKey, baseURL: named.baseURL }

  return {}
}

function resolveBalanceUrl(baseURL?: string): string {
  const override = process.env.DEEPSEEK_BALANCE_URL?.trim()
  if (override) return override

  if (baseURL) {
    try {
      const url = new URL("/user/balance", baseURL)
      if (url.protocol === "http:" || url.protocol === "https:") return url.toString()
    } catch {
      // 无效 baseURL 时回退官方地址
    }
  }

  return DEFAULT_BALANCE_URL
}

async function fetchBalance(apiKey: string, url: string): Promise<BalanceState> {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })

  if (!response.ok) throw new HttpError(response.status)

  const body = (await response.json()) as BalanceResponse | null
  const infos = Array.isArray(body?.balance_infos) ? body.balance_infos : []

  return {
    isAvailable: body?.is_available !== false,
    infos: infos.map((info) => ({
      currency: info.currency === "USD" ? "USD" : "CNY",
      total: toNumber(info.total_balance),
      granted: toNumber(info.granted_balance),
      toppedUp: toNumber(info.topped_up_balance),
    })),
    fetchedAt: Date.now(),
  }
}

function formatAmount(currency: Currency, value: number): string {
  const symbol = currency === "USD" ? "$" : "¥"
  return `${symbol}${MONEY_FORMATTER.format(value)}`
}

function formatEstimate(currency: Currency, value: number): string {
  const symbol = currency === "USD" ? "$" : "¥"
  const absolute = Math.abs(value)

  if (absolute === 0) return `${symbol}0.00`
  if (currency === "USD" && absolute < 0.0001) return `<${symbol}0.0001`
  if (absolute < 0.01) return `<${symbol}0.01`
  if (currency === "USD" && absolute < 1) return `${symbol}${value.toFixed(4)}`
  return `${symbol}${value.toFixed(2)}`
}

function formatTime(ms: number): string {
  const date = new Date(ms)
  const hours = String(date.getHours()).padStart(2, "0")
  const minutes = String(date.getMinutes()).padStart(2, "0")
  return `${hours}:${minutes}`
}

// 按消息逐条估算当前会话费用，避免会话中途切换模型时把 token 混在一起。
function estimateSessionCost(
  context: any,
  sessionID: string,
  currency: Currency,
): number | undefined {
  let messages: any[] = []
  try {
    messages = context?.data?.session?.message?.list?.(sessionID) ?? []
  } catch {
    return undefined
  }

  let total = 0
  let priced = 0

  for (const message of messages) {
    if (message?.type !== "assistant" && message?.type !== "compaction") continue
    const tokens = message.tokens
    if (!tokens) continue

    const modelID = message.model?.id ?? message.model?.modelID
    const price = priceFor(modelID, currency, message.time?.created ?? Date.now())
    if (!price) continue

    total += tokensCost(tokens, price)
    priced += 1
  }

  if (priced > 0) return total

  // 消息列表尚未同步时，用会话汇总 token 做一次粗略回退。
  try {
    const session = context?.data?.session?.get?.(sessionID)
    const tokens = session?.tokens
    if (!tokens) return undefined

    const modelID =
      session?.model?.id ??
      session?.model?.modelID ??
      context?.ui?.model?.current?.()?.modelID
    const price = priceFor(modelID, currency, Date.now())
    if (!price) return undefined

    return tokensCost(tokens, price)
  } catch {
    return undefined
  }
}

// 调用 OpenCode 的 stats 接口，按时间范围读取本地会话 token。
async function fetchStats(context: any, from: number, to: number): Promise<StatsSnapshot> {
  const session = context?.client?.session
  if (typeof session?.stats !== "function") {
    throw new Error("session.stats 不可用")
  }

  const response = await session.stats({
    from,
    to,
    timezone: STATS_TIMEZONE,
    tools: "none",
  })

  if (response && typeof response === "object" && "error" in response && response.error) {
    throw new Error(String(response.error?.message ?? response.error))
  }

  const data =
    response && typeof response === "object" && "data" in response ? response.data : response
  if (!data || typeof data !== "object") {
    throw new Error("session.stats 返回异常")
  }

  return normalizeStats(data)
}

// 找出与当前 API Key 相同的 provider，避免把另一个 DeepSeek 账号的用量算进来。
function providerIDsForAccount(context: any, model: any, apiKey?: string): Set<string> {
  const ids = new Set<string>()
  if (model?.providerID) ids.add(String(model.providerID))
  if (!apiKey) return ids

  for (const file of configFiles(context?.location?.directory)) {
    const config = readJsonc(file)
    if (!config) continue

    for (const entry of providerEntries(config)) {
      const key = resolveApiKeyValue(entry.options.apiKey ?? entry.raw.apiKey)
      if (key === apiKey) ids.add(entry.id)
    }
  }

  return ids
}

// 估算当前 DeepSeek 账号今日的用量费用。峰值窗口单独查询，再用全天数据相减得到谷值。
async function fetchTodayUsage(
  context: any,
  model: any,
  currency: Currency,
): Promise<number | undefined> {
  const provider = resolveProviderConfig(context, model)
  if (!provider.apiKey) return undefined

  const now = Date.now()
  const dayStart = startOfBeijingDay(now)
  const providerIDs = providerIDsForAccount(context, model, provider.apiKey)

  const all = ensureModel(
    await fetchStats(context, dayStart, now),
    model?.providerID,
    model?.modelID,
  )

  if (all.models.length === 0 && isEmptyUsage(all.tokens)) return 0

  const peak = mergeStats(
    await Promise.all(
      peakWindows(dayStart, now).map(([from, to]) =>
        fetchStats(context, from, to).then((snapshot) =>
          ensureModel(snapshot, model?.providerID, model?.modelID),
        ),
      ),
    ),
  )
  const offPeak = subtractStats(all, peak)

  return calculateUsageCost(peak, offPeak, currency, providerIDs)
}

function isDeepSeekModel(model: any): boolean {
  if (!model) return false
  return (
    /deepseek/i.test(String(model.modelID ?? "")) ||
    /deepseek/i.test(String(model.providerID ?? ""))
  )
}

function shortError(error: unknown): string {
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return "Key 无效"
    if (error.status === 429) return "请求过频"
    return `HTTP ${error.status}`
  }

  if (error instanceof Error) {
    if (error.name === "TimeoutError" || /timeout/i.test(error.message)) return "网络超时"
    if (/fetch failed|network|ECONN|connect|ConnectionRefused/i.test(error.message)) return "网络错误"
  }

  return "余额获取失败"
}

function charWidth(code: number): number {
  if (code === 0) return 0
  if (code < 32 || (code >= 0x7f && code < 0xa0)) return 0
  if (
    (code >= 0x1100 && code <= 0x115f) ||
    code === 0x2329 ||
    code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) ||
    (code >= 0x1f900 && code <= 0x1f9ff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) {
    return 2
  }
  return 1
}

function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    width += charWidth(char.codePointAt(0) ?? 0)
  }
  return width
}

function padLabel(label: string): string {
  const width = 8
  return label + " ".repeat(Math.max(1, width - displayWidth(label)))
}

function BalanceRow(props: {
  label: string
  value: string
  labelColor: any
  valueColor: any
}) {
  return (
    <box flexDirection="row">
      <text fg={props.labelColor}>{padLabel(props.label)}</text>
      <text fg={props.valueColor}>{props.value}</text>
    </box>
  )
}

function BalanceCard(props: {
  sessionID: string
  balance: BalanceState | null
  todayCost: number | undefined
  error: string | null
  refreshing: boolean
  context: any
  theme: any
}) {
  const text = props.theme.text
  const primary = () => props.balance?.infos[0]
  const currency = (): Currency => primary()?.currency ?? "CNY"
  const cost = createMemo(() => {
    if (!props.balance) return undefined
    return estimateSessionCost(props.context, props.sessionID, currency())
  })

  return (
    <box flexDirection="column" gap={0} marginBottom={1}>
      <box flexDirection="row">
        <text fg={text.base}>DeepSeek</text>
        <text fg={text.faint}> 余额</text>
      </box>

      <Show
        when={props.balance}
        fallback={
          <Show
            when={props.error}
            fallback={<text fg={text.faint}>余额加载中</text>}
          >
            <text fg={text.feedback?.error?.base ?? text.muted}>{props.error}</text>
          </Show>
        }
      >
        <box flexDirection="column" gap={0} marginTop={1}>
          <For each={props.balance?.infos ?? []}>
            {(info) => (
              <BalanceRow
                label={props.balance && props.balance.infos.length > 1 ? info.currency : "余额"}
                value={formatAmount(info.currency, info.total)}
                labelColor={text.muted}
                valueColor={text.base}
              />
            )}
          </For>

          <Show when={(props.balance?.infos.length ?? 0) === 0}>
            <text fg={text.muted}>无余额信息</text>
          </Show>

          <Show when={props.balance?.isAvailable === false}>
            <text fg={text.feedback?.warning?.base ?? text.muted}>余额不足</text>
          </Show>

          <Show when={primary()}>
            {(info: () => NormalizedBalanceInfo) => (
              <>
                <Show when={info().granted > 0}>
                  <BalanceRow
                    label="赠送"
                    value={formatAmount(info().currency, info().granted)}
                    labelColor={text.muted}
                    valueColor={text.muted}
                  />
                </Show>
                <Show when={info().toppedUp > 0}>
                  <BalanceRow
                    label="充值"
                    value={formatAmount(info().currency, info().toppedUp)}
                    labelColor={text.muted}
                    valueColor={text.muted}
                  />
                </Show>
              </>
            )}
          </Show>

          <Show when={cost()}>
            <BalanceRow
              label="本次约"
              value={formatEstimate(currency(), cost() ?? 0)}
              labelColor={text.muted}
              valueColor={text.muted}
            />
          </Show>

          <Show when={props.todayCost !== undefined}>
            <BalanceRow
              label="今日约"
              value={formatEstimate(currency(), props.todayCost ?? 0)}
              labelColor={text.muted}
              valueColor={text.muted}
            />
          </Show>

          <Show when={props.error}>
            <text fg={text.feedback?.error?.base ?? text.muted} truncate>
              刷新失败：{props.error}
            </text>
          </Show>

          <BalanceRow
            label="更新"
            value={props.refreshing ? "刷新中" : formatTime(props.balance?.fetchedAt ?? Date.now())}
            labelColor={text.faint}
            valueColor={text.faint}
          />
        </box>
      </Show>
    </box>
  )
}

export default Plugin.define({
  id: "deepseek.balance",
  async setup(context: any) {
    const [balance, setBalance] = createSignal<BalanceState | null>(null)
    const [todayCost, setTodayCost] = createSignal<number | undefined>(undefined)
    const [error, setError] = createSignal<string | null>(null)
    const [refreshing, setRefreshing] = createSignal(false)

    let inFlight = false
    let usageInFlight = false
    let lastAttemptAt = 0
    let lastSuccessAt = 0
    let lastProviderID: string | undefined

    const currentModel = () => context.ui.model.current()
    const isDeepSeek = () => isDeepSeekModel(currentModel())

    async function refresh(force = false): Promise<boolean> {
      if (inFlight) return false

      const model = currentModel()
      if (!isDeepSeekModel(model)) return false
      if (!force && Date.now() - lastAttemptAt < 1000) return false

      const providerID = model?.providerID
      const provider = resolveProviderConfig(context, model)
      if (!provider.apiKey) {
        setError("未配置 Key")
        return false
      }

      inFlight = true
      setRefreshing(true)
      lastAttemptAt = Date.now()

      try {
        const next = await fetchBalance(provider.apiKey, resolveBalanceUrl(provider.baseURL))
        setBalance(next)
        setError(null)
        lastSuccessAt = Date.now()
        lastProviderID = providerID
        return true
      } catch (cause) {
        setError(shortError(cause))
        return false
      } finally {
        inFlight = false
        setRefreshing(false)
      }
    }

    async function refreshUsage(): Promise<void> {
      if (usageInFlight) return
      if (!isDeepSeek()) return

      const primary = balance()?.infos[0]
      if (!primary) return

      usageInFlight = true
      try {
        const cost = await fetchTodayUsage(context, currentModel(), primary.currency)
        setTodayCost(cost)
      } catch {
        setTodayCost(undefined)
      } finally {
        usageInFlight = false
      }
    }

    async function refreshAll(force = false): Promise<boolean> {
      const ok = await refresh(force)
      if (ok || balance()) await refreshUsage()
      return ok
    }

    // 首次进入以及切换到 DeepSeek 模型时按需加载，不阻塞插件 setup。
    createEffect(() => {
      const model = currentModel()
      if (!isDeepSeekModel(model)) return
      if (
        lastSuccessAt === 0 ||
        lastProviderID !== model?.providerID ||
        Date.now() - lastSuccessAt >= REFRESH_MS
      ) {
        void refreshAll()
      }
    })

    const refreshTimer = setInterval(() => {
      if (isDeepSeek()) void refreshAll()
    }, REFRESH_MS)

    // 每轮会话结束后刷新一次，60 秒内最多一次，避免频繁请求。
    const stopIdle = context.data.on("session.idle", () => {
      if (!isDeepSeek()) return
      if (Date.now() - lastAttemptAt < IDLE_THROTTLE_MS) return
      void refreshAll()
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "deepseek.balance.refresh",
          title: "刷新 DeepSeek 余额",
          group: "DeepSeek",
          palette: true,
          slash: { name: "deepseek-balance" },
          run: async () => {
            if (!isDeepSeek()) {
              context.ui.toast.show({ message: "当前模型不是 DeepSeek", variant: "info" })
              return
            }
            if (inFlight) {
              context.ui.toast.show({ message: "正在刷新 DeepSeek 余额", variant: "info" })
              return
            }

            const ok = await refreshAll(true)
            context.ui.toast.show({
              message: ok
                ? "DeepSeek 余额已刷新"
                : `DeepSeek 余额刷新失败：${error() ?? "未知错误"}`,
              variant: ok ? "success" : "error",
            })
          },
        },
      ],
    }))

    const unregisterSlot = context.ui.slot({
      prepend: "sidebar.content",
      render: ({ sessionID }: { sessionID: string }) => (
        <Show when={isDeepSeek()}>
          <BalanceCard
            sessionID={sessionID}
            balance={balance()}
            todayCost={todayCost()}
            error={error()}
            refreshing={refreshing()}
            context={context}
            theme={context.theme}
          />
        </Show>
      ),
    })

    return () => {
      unregisterSlot()
      clearInterval(refreshTimer)
      stopIdle()
    }
  },
})
