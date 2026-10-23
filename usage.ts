// 今日用量估算与 DeepSeek 价格计算。
// 本文件不依赖 OpenCode/TUI 运行时，便于单独验证峰谷窗口和费用公式。

export type Currency = "CNY" | "USD"

export type Price = {
  cacheHit: number
  cacheMiss: number
  output: number
}

export type PriceSet = {
  peak: Price
  offPeak: Price
}

export type Usage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
}

export type ModelUsage = {
  providerID: string
  modelID: string
  tokens: Usage
}

export type StatsSnapshot = {
  models: ModelUsage[]
  tokens: Usage
}

export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000

// DeepSeek 官方单价，单位：每百万 token。峰谷价按北京时间计算。
export const PRICE_TABLE: Record<string, Record<Currency, PriceSet>> = {
  "deepseek-flash": {
    CNY: {
      peak: { cacheHit: 0.04, cacheMiss: 2, output: 8 },
      offPeak: { cacheHit: 0.02, cacheMiss: 1, output: 4 },
    },
    USD: {
      peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
      offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
    },
  },
  "deepseek-v4-pro": {
    CNY: {
      peak: { cacheHit: 0.3, cacheMiss: 9, output: 27 },
      offPeak: { cacheHit: 0.15, cacheMiss: 4.5, output: 13.5 },
    },
    USD: {
      peak: { cacheHit: 0.044, cacheMiss: 1.32, output: 3.96 },
      offPeak: { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
    },
  },
}

export const MODEL_ALIASES: Record<string, string> = {
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
  "deepseek-v4.1-flash": "deepseek-flash",
  "deepseek-flash-1017": "deepseek-flash",
}

function emptyUsage(): Usage {
  return { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }
}

function modelKey(model: Pick<ModelUsage, "providerID" | "modelID">): string {
  return `${model.providerID}\u0000${model.modelID}`
}

export function toNumber(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0
  if (typeof value === "string") {
    const parsed = Number(value.replace(/,/g, ""))
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

// 返回给定时刻所在北京日的 00:00 时间戳。
export function startOfBeijingDay(ms: number): number {
  const shifted = new Date(ms + BEIJING_OFFSET_MS)
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    BEIJING_OFFSET_MS
  )
}

// 返回今天已经开始的 DeepSeek 高峰窗口，按北京时间工作日 09-12、14-18 计算。
export function peakWindows(dayStart: number, now: number): Array<[number, number]> {
  const shifted = new Date(dayStart + BEIJING_OFFSET_MS)
  const day = shifted.getUTCDay()
  if (day === 0 || day === 6) return []

  const windows: Array<[number, number]> = []
  for (const [startHour, endHour] of [
    [9, 12],
    [14, 18],
  ] as const) {
    const start = dayStart + startHour * 60 * 60 * 1000
    const end = dayStart + endHour * 60 * 60 * 1000
    if (now <= start) continue
    windows.push([start, Math.min(now, end)])
  }
  return windows
}

// 判断消息创建时间是否处于 DeepSeek 高峰时段（北京时间工作日 09-12、14-18）。
export function isPeak(ms: number): boolean {
  const date = new Date(ms + BEIJING_OFFSET_MS)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false

  const hour = date.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}

export function priceFor(
  modelID: string | undefined,
  currency: Currency,
  at: number,
): Price | undefined {
  if (!modelID) return undefined
  const key = MODEL_ALIASES[modelID] ?? modelID
  const prices = PRICE_TABLE[key]
  if (!prices) return undefined

  const set = prices[currency]
  return isPeak(at) ? set.peak : set.offPeak
}

// 按每百万 token 单价计算费用。cacheWrite 目前按 0 计费，保留字段以便后续调整。
export function costOf(
  input: number,
  output: number,
  reasoning: number,
  cacheRead: number,
  cacheWrite: number,
  price: Price,
): number {
  return (
    (Math.max(0, input) * price.cacheMiss +
      Math.max(0, output + reasoning) * price.output +
      Math.max(0, cacheRead) * price.cacheHit +
      Math.max(0, cacheWrite) * 0) /
    1_000_000
  )
}

export function tokensCost(tokens: any, price: Price): number {
  return costOf(
    toNumber(tokens?.input),
    toNumber(tokens?.output),
    toNumber(tokens?.reasoning),
    toNumber(tokens?.cache?.read),
    toNumber(tokens?.cache?.write),
    price,
  )
}

export function normalizeUsage(tokens: any): Usage {
  return {
    input: Math.max(0, toNumber(tokens?.input)),
    output: Math.max(0, toNumber(tokens?.output)),
    reasoning: Math.max(0, toNumber(tokens?.reasoning)),
    cacheRead: Math.max(0, toNumber(tokens?.cache?.read)),
    cacheWrite: Math.max(0, toNumber(tokens?.cache?.write)),
  }
}

export function normalizeStats(raw: any): StatsSnapshot {
  const models: ModelUsage[] = []
  for (const item of Array.isArray(raw?.models) ? raw.models : []) {
    const modelID = item?.model?.id ?? item?.model?.modelID
    const providerID = item?.model?.providerID
    if (!modelID || !providerID) continue

    models.push({
      providerID: String(providerID),
      modelID: String(modelID),
      tokens: normalizeUsage(item.tokens),
    })
  }

  return { models, tokens: normalizeUsage(raw?.tokens) }
}

// 旧版 stats 可能只返回顶层 tokens，此时用当前模型补一个 model 条目。
export function ensureModel(
  snapshot: StatsSnapshot,
  providerID?: string,
  modelID?: string,
): StatsSnapshot {
  if (snapshot.models.length > 0) return snapshot
  if (!providerID || !modelID || isEmptyUsage(snapshot.tokens)) return snapshot

  return {
    models: [{ providerID: String(providerID), modelID: String(modelID), tokens: snapshot.tokens }],
    tokens: snapshot.tokens,
  }
}

export function addUsage(left: Usage, right: Usage): Usage {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    reasoning: left.reasoning + right.reasoning,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
  }
}

export function subtractUsage(left: Usage, right: Usage): Usage {
  return {
    input: Math.max(0, left.input - right.input),
    output: Math.max(0, left.output - right.output),
    reasoning: Math.max(0, left.reasoning - right.reasoning),
    cacheRead: Math.max(0, left.cacheRead - right.cacheRead),
    cacheWrite: Math.max(0, left.cacheWrite - right.cacheWrite),
  }
}

export function mergeStats(snapshots: StatsSnapshot[]): StatsSnapshot {
  const models = new Map<string, ModelUsage>()
  let tokens = emptyUsage()

  for (const snapshot of snapshots) {
    tokens = addUsage(tokens, snapshot.tokens)
    for (const model of snapshot.models) {
      const key = modelKey(model)
      const existing = models.get(key)
      if (existing) {
        existing.tokens = addUsage(existing.tokens, model.tokens)
      } else {
        models.set(key, { ...model, tokens: { ...model.tokens } })
      }
    }
  }

  return { models: [...models.values()], tokens }
}

export function subtractStats(all: StatsSnapshot, part: StatsSnapshot): StatsSnapshot {
  const models = all.models.map((model) => ({ ...model, tokens: { ...model.tokens } }))
  const byKey = new Map<string, ModelUsage>()
  for (const model of models) byKey.set(modelKey(model), model)

  for (const model of part.models) {
    const target = byKey.get(modelKey(model))
    if (!target) continue
    target.tokens = subtractUsage(target.tokens, model.tokens)
  }

  return { models, tokens: subtractUsage(all.tokens, part.tokens) }
}

export function calculateUsageCost(
  peak: StatsSnapshot,
  offPeak: StatsSnapshot,
  currency: Currency,
  providerIDs: Set<string>,
): number | undefined {
  let total = 0
  let priced = false

  const add = (models: ModelUsage[], mode: "peak" | "offPeak") => {
    for (const model of models) {
      if (!providerIDs.has(model.providerID)) continue

      const key = MODEL_ALIASES[model.modelID] ?? model.modelID
      const prices = PRICE_TABLE[key]
      if (!prices) continue

      total += costOf(
        model.tokens.input,
        model.tokens.output,
        model.tokens.reasoning,
        model.tokens.cacheRead,
        model.tokens.cacheWrite,
        prices[currency][mode],
      )
      priced = true
    }
  }

  add(peak.models, "peak")
  add(offPeak.models, "offPeak")
  return priced ? total : undefined
}

export function isEmptyUsage(usage: Usage): boolean {
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.reasoning === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0
  )
}
