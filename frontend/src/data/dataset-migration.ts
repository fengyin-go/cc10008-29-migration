/**
 * 数据集定义迁移引擎（纯逻辑，不直接碰 localStorage / DOM）。
 *
 * 背景：旧版把数据集定义存成扁平 EntryRow，「字段列表」只是一段逗号字符串，
 * 也没有任何版本标记。本引擎负责把存量记录逐条迁成可校验的字段契约（v2），
 * 并满足：断点续迁、幂等去重、问题记录隔离留证、读旧/读新原子切换、
 * 失败转换不占正式版本号。
 *
 * 浏览器相关能力（存储、锁、跨页事件）全部经 StoragePort 注入，
 * 因此同一份引擎既能在页面里跑，也能在 Node 测试里用内存实现跑。
 */

// ---------------------------------------------------------------------------
// 领域类型
// ---------------------------------------------------------------------------

/** 留证原因：每种问题独立留一类证，便于后续追溯。 */
export type EvidenceCode =
  | 'UNPARSEABLE_RECORD' // 整段内容无法解析，连最小身份信息都取不到
  | 'MISSING_FIELD' // 旧记录缺字段，按约定标未确认而不是补默认值
  | 'FIELD_NAME_WITH_COMMA' // 字段名里含逗号，逗号字符串无法无歧义切分
  | 'FIELD_TYPE_EMPTY' // 字段类型为空
  | 'LIFECYCLE_DAYS_INVALID' // 生命周期天数非法
  | 'PENDING_CONVERSION' // 迁移期旧页面写回、不符合新结构，待人工转换
  | 'REPEATED_MIGRATION' // 同一记录再次进入迁移，已存在正式版本

/** 一条隔离/留证记录。失败的转换结果只进这里，绝不占用正式版本号。 */
export interface MigrationEvidence {
  code: EvidenceCode
  message: string
  /** 出错时的原始片段（字段名、原值等），用于留证排查。 */
  detail?: unknown
  at: number
}

/** 字段契约：v2 里每个字段都是可校验的结构化对象，顺序即原始字段顺序。 */
export interface DatasetField {
  name: string
  /** 类型为空时为 null，并由 confirmed=false 标记，不补造默认类型。 */
  type: string | null
  /** false 表示该字段未确认（类型缺失等），需要人工复核。 */
  confirmed: boolean
}

/** 可校验的数据集定义（新结构 / 字段契约）。 */
export interface DatasetContract {
  schemaVersion: 2
  /** 正式版本号：迁移成功的记录按提交顺序递增，隔离记录不占用。 */
  version: number
  /** 沿用旧记录的数据集编号（如 DATA-0001），缺省时由 id 兜底。 */
  datasetCode: string
  name: string
  /** 来源表名：缺失时为 null 且未确认，保留语义不补造。 */
  sourceTable: string | null
  sourceTableConfirmed: boolean
  /** 更新策略：缺失时为 null 且未确认。 */
  updateStrategy: string | null
  updateStrategyConfirmed: boolean
  /** 结构化字段列表，顺序与旧逗号字符串一致。 */
  fields: DatasetField[]
  /** 生命周期天数（合法正整数），非法或缺失时为 null 且未确认。 */
  lifecycleDays: number | null
  lifecycleConfirmed: boolean
  /** 关联旧记录的行 id。 */
  sourceRowId: number
  /** 旧记录指纹：迁移成功后仍保留，用于幂等去重与重建。 */
  sourceFingerprint: string
  /** 整条契约是否完全确认（没有任何未确认项）。 */
  confirmed: boolean
  /** 迁移过程中产生的留证（缺字段、逗号、空类型、非法天数等）。 */
  evidence: MigrationEvidence[]
  migratedAt: number
}

/** 隔离区里的记录：无法解析或校验不过的内容原样留证。 */
export interface QuarantineRecord {
  /** 隔离编号用独立号段（Q- 前缀），不占正式版本号。 */
  quarantineId: string
  /** 能取到行 id 就带上，取不到为 null。 */
  sourceRowId: number | null
  /** 能算指纹就算（用于去重），无法解析时为 null。 */
  sourceFingerprint: string | null
  /** 来源批次：记录是第几批迁移隔离的，断点恢复可核对。 */
  originBatch: number
  reason: EvidenceCode
  evidence: MigrationEvidence[]
  /** 原始内容原样保存，隔离留证。 */
  raw: unknown
  at: number
}

/** 迁移期旧页面写回、但不符合新结构的记录：保留为待转换并阻止其发布。 */
export interface PendingConversion {
  pendingId: string
  sourceFingerprint: string
  evidence: MigrationEvidence[]
  raw: unknown
  at: number
}

/** 迁移阶段：未开始 / 进行中（读旧契约）/ 已完成（读新契约）。 */
export type MigrationPhase = 'idle' | 'migrating' | 'completed'

/** 迁移的可持久化状态机。 */
export interface MigrationState {
  schemaVersion: 2
  phase: MigrationPhase
  /** 已成功迁移的正式契约，version 唯一且连续。 */
  contracts: DatasetContract[]
  /** 隔离留证记录（含无法解析、字段名逗号、空类型、非法天数等）。 */
  quarantine: QuarantineRecord[]
  /** 迁移期写回的待转换记录。 */
  pending: PendingConversion[]
  /** 已处理记录的指纹集合（序列化为数组持久化），保证幂等。 */
  processedFingerprints: string[]
  /** 最后完成的数据集行 id：中途失败后从它之后继续。 */
  lastCompletedRowId: number | null
  /** 已提交的批次数（每次原子提交 +1）。 */
  lastBatchNo: number
  /** 下一个正式版本号；隔离/待转换不消耗它。 */
  nextVersion: number
  /** 下一个隔离号段序号。 */
  nextQuarantineSeq: number
  /** 下一个待转换号段序号。 */
  nextPendingSeq: number
  updatedAt: number
}

/** 迁移运行结果，便于页面/测试观察。 */
export interface MigrationRunResult {
  state: MigrationState
  /** 本次调用实际新迁移的条数。 */
  migrated: number
  /** 本次调用新隔离的条数。 */
  quarantined: number
  /** 是否因为拿不到锁（别的标签页正在迁移）而没有执行。 */
  skippedByLock: boolean
}

// ---------------------------------------------------------------------------
// 存储端口：引擎只依赖这个最小接口
// ---------------------------------------------------------------------------

export interface StorageLockInfo {
  owner: string
  acquiredAt: number
  expiresAt: number
}

export interface StoragePort {
  get<T>(key: string): T | null
  set(key: string, value: unknown): void
  /** 一次原子写多个键：批次要么整体可见，要么不可见，避免半迁移数据。 */
  setMany(entries: { key: string; value: unknown }[]): void
  remove(key: string): void
  /** 跨标签页变更订阅，返回退订函数。 */
  subscribe(listener: () => void): () => void
  /** 取锁；拿不到（被他人持有且未过期）返回 null。 */
  acquireLock(owner: string, ttlMs: number): StorageLockInfo | null
  /** 仅当锁仍属于 owner 时续租；返回最新锁信息，丢失则返回 null。 */
  renewLock(owner: string, ttlMs: number): StorageLockInfo | null
  releaseLock(owner: string): void
  readLock(): StorageLockInfo | null
  /** 单调时钟，注入便于测试。 */
  now(): number
}

// ---------------------------------------------------------------------------
// 常量与键名
// ---------------------------------------------------------------------------

export const CONTRACT_SCHEMA_VERSION = 2 as const
export const LEGACY_DATASET_MODULE = 'datastore'

/** 新结构与迁移状态使用独立键，迁移期与旧键并存（旧契约可回读）。 */
export const STORAGE_KEYS = {
  state: 'interactive-analytics-lab:dataset-migration:v2',
  lock: 'interactive-analytics-lab:dataset-migration:lock',
  /** 已切换到新契约的读取方登记：旧键清理要等它们全部就绪。 */
  readers: 'interactive-analytics-lab:dataset-migration:readers',
  /** 迁移期写回、待转换记录的暂存键。 */
  pending: 'interactive-analytics-lab:dataset-migration:pending',
} as const

/** 旧版扁平记录所在键（local-store 里的 entries 总键）。 */
export const LEGACY_ENTRIES_KEY = 'interactive-analytics-lab:entries'

const DEFAULT_BATCH_SIZE = 5
const LOCK_TTL_MS = 15_000

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 旧记录指纹：稳定序列化后做轻量哈希，作为幂等与重建的依据。 */
export function fingerprint(row: unknown): string {
  const json = JSON.stringify(row)
  let hash = 5381
  for (let i = 0; i < json.length; i += 1) {
    hash = (hash * 33) ^ json.charCodeAt(i)
  }
  // 转无符号 32 位再转 16 进制，前缀标注来源长度避免极端碰撞。
  return `fp${json.length.toString(36)}-${(hash >>> 0).toString(16)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function evidence(code: EvidenceCode, message: string, detail: unknown, now: number): MigrationEvidence {
  return { code, message, detail, at: now }
}

// ---------------------------------------------------------------------------
// 逗号字符串解析：识别引号转义，保留原始字段顺序，字段名含逗号要留证
// ---------------------------------------------------------------------------

export interface ParsedFieldList {
  fields: DatasetField[]
  evidences: MigrationEvidence[]
}

/**
 * 解析旧的「字段列表」逗号字符串。
 * - 支持双引号包裹（"" 转义），引号内的逗号不参与切分；
 * - 一旦出现「字段名里含逗号」，单独留 FIELD_NAME_WITH_COMMA 证据；
 * - 支持 "名称:类型" 写法；类型为空留 FIELD_TYPE_EMPTY 证据；
 * - 顺序完全保留。
 */
export function parseFieldList(raw: unknown, now: number): ParsedFieldList {
  const evidences: MigrationEvidence[] = []
  const text = raw === null || raw === undefined ? '' : String(raw)
  const tokens: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          current += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        current += ch
      }
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      tokens.push(current)
      current = ''
    } else {
      current += ch
    }
  }
  tokens.push(current)

  const fields: DatasetField[] = []
  for (const token of tokens) {
    const trimmed = token.trim()
    // 字符串整体为空或以逗号结尾时，末尾会产生空串，忽略而不是造空字段。
    if (trimmed === '') {
      continue
    }
    const colon = trimmed.indexOf(':')
    let name = trimmed
    let type: string | null = null
    if (colon >= 0) {
      name = trimmed.slice(0, colon).trim()
      const typeText = trimmed.slice(colon + 1).trim()
      type = typeText === '' ? null : typeText
    }
    if (name.includes(',')) {
      evidences.push(
        evidence('FIELD_NAME_WITH_COMMA', `字段名「${name}」含逗号，逗号字符串无法无歧义切分`, name, now),
      )
    }
    let confirmed = true
    if (type === null) {
      evidences.push(
        evidence('FIELD_TYPE_EMPTY', `字段「${name}」类型为空，已标记为未确认`, name, now),
      )
      confirmed = false
    }
    fields.push({ name, type, confirmed })
  }

  return { fields, evidences }
}

// ---------------------------------------------------------------------------
// 单条记录转换：要么产出正式契约，要么产出隔离记录，二者互斥
// ---------------------------------------------------------------------------

export type ConvertResult =
  | { ok: true; contract: DatasetContract; evidences: MigrationEvidence[] }
  | { ok: false; quarantine: Omit<QuarantineRecord, 'quarantineId' | 'originBatch'> }

interface ConvertContext {
  version: number
  now: number
}

/** 取可选文本字段：缺失/空 -> null + 未确认 + 留证，绝不补造默认值。 */
function optionalText(
  row: Record<string, unknown>,
  key: string,
  code: EvidenceCode,
  now: number,
): { value: string | null; confirmed: boolean; evidences: MigrationEvidence[] } {
  const raw = row[key]
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return {
      value: null,
      confirmed: false,
      evidences: [evidence(code, `字段「${key}」缺失，已标记为未确认`, raw ?? null, now)],
    }
  }
  return { value: String(raw), confirmed: true, evidences: [] }
}

/**
 * 把一条旧扁平记录转成字段契约。
 * 无法解析（不是对象 / 没有行 id）直接判定为隔离。
 */
export function convertLegacyRecord(
  row: unknown,
  ctx: ConvertContext,
): ConvertResult {
  const now = ctx.now
  if (!isRecord(row) || typeof row.id !== 'number' || !Number.isFinite(row.id)) {
    const fp = isRecord(row) ? fingerprint(row) : null
    return {
      ok: false,
      quarantine: {
        sourceRowId: isRecord(row) && typeof row.id === 'number' ? row.id : null,
        sourceFingerprint: fp,
        reason: 'UNPARSEABLE_RECORD',
        evidence: [evidence('UNPARSEABLE_RECORD', '记录无法解析为数据集定义对象', row, now)],
        raw: clone(row),
        at: now,
      },
    }
  }

  const sourceRowId = row.id
  const sourceFingerprint = fingerprint(row)

  const sourceTable = optionalText(row, '来源表名', 'MISSING_FIELD', now)
  const updateStrategy = optionalText(row, '更新策略', 'MISSING_FIELD', now)

  // 字段列表：保留原始顺序，逗号/空类型问题在解析阶段留证。
  const parsed = parseFieldList(row['字段列表'], now)

  // 生命周期天数：必须是正整数，否则标记未确认并留证（记录仍可迁移）。
  let lifecycleDays: number | null = null
  let lifecycleConfirmed = true
  const lifecycleEvidences: MigrationEvidence[] = []
  const rawLifecycle = row['生命周期天数']
  if (rawLifecycle === undefined || rawLifecycle === null || String(rawLifecycle).trim() === '') {
    lifecycleConfirmed = false
    lifecycleEvidences.push(
      evidence('MISSING_FIELD', '字段「生命周期天数」缺失，已标记为未确认', rawLifecycle ?? null, now),
    )
  } else {
    const num = Number(rawLifecycle)
    if (!Number.isInteger(num) || num <= 0) {
      lifecycleConfirmed = false
      lifecycleEvidences.push(
        evidence('LIFECYCLE_DAYS_INVALID', `生命周期天数「${String(rawLifecycle)}」非法，须为正整数`, rawLifecycle, now),
      )
    } else {
      lifecycleDays = num
    }
  }

  const codeText = row['数据集编号']
  const nameText = row['数据集名称']
  const evidences: MigrationEvidence[] = [
    ...sourceTable.evidences,
    ...updateStrategy.evidences,
    ...parsed.evidences,
    ...lifecycleEvidences,
  ]

  const contract: DatasetContract = {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    version: ctx.version,
    datasetCode: codeText === undefined || String(codeText).trim() === '' ? `DATA-${sourceRowId}` : String(codeText),
    name: nameText === undefined || String(nameText).trim() === '' ? `未命名数据集-${sourceRowId}` : String(nameText),
    sourceTable: sourceTable.value,
    sourceTableConfirmed: sourceTable.confirmed,
    updateStrategy: updateStrategy.value,
    updateStrategyConfirmed: updateStrategy.confirmed,
    fields: parsed.fields,
    lifecycleDays,
    lifecycleConfirmed,
    sourceRowId,
    sourceFingerprint,
    confirmed:
      sourceTable.confirmed &&
      updateStrategy.confirmed &&
      lifecycleConfirmed &&
      parsed.fields.every((field) => field.confirmed),
    evidence: evidences,
    migratedAt: now,
  }

  return { ok: true, contract, evidences }
}

// ---------------------------------------------------------------------------
// 状态初始化与读取
// ---------------------------------------------------------------------------

export function createInitialState(now: number): MigrationState {
  return {
    schemaVersion: CONTRACT_SCHEMA_VERSION,
    phase: 'idle',
    contracts: [],
    quarantine: [],
    pending: [],
    processedFingerprints: [],
    lastCompletedRowId: null,
    lastBatchNo: 0,
    nextVersion: 1,
    nextQuarantineSeq: 1,
    nextPendingSeq: 1,
    updatedAt: now,
  }
}

export function loadState(port: StoragePort): MigrationState {
  const existing = port.get<MigrationState>(STORAGE_KEYS.state)
  if (existing && existing.schemaVersion === CONTRACT_SCHEMA_VERSION) {
    return existing
  }
  return createInitialState(port.now())
}

// ---------------------------------------------------------------------------
// 迁移主流程：分批、可续跑、幂等、跨标签页互斥
// ---------------------------------------------------------------------------

export interface RunOptions {
  batchSize?: number
  /** 测试钩子：在每次批次提交前抛错，模拟中途失败。 */
  failBeforeCommit?: (batchNo: number) => boolean
}

/**
 * 迁移入口（两个业务入口共用这一个步骤）。
 * 返回结果里的 state 始终是已持久化的最新状态。
 */
export function runMigration(
  port: StoragePort,
  legacyRows: unknown[],
  options: RunOptions = {},
): MigrationRunResult {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const now = port.now()

  // 跨标签页互斥：同一时刻只允许一个标签页提交批次。
  const owner = `tab-${Math.random().toString(36).slice(2, 10)}`
  let lock = port.acquireLock(owner, LOCK_TTL_MS)
  if (!lock) {
    return { state: loadState(port), migrated: 0, quarantined: 0, skippedByLock: true }
  }

  try {
    let state = loadState(port)
    // 已完成仍允许重跑：新出现的旧记录会被补迁，已处理指纹保证幂等不重复。
    const startedCompleted = state.phase === 'completed'
    if (!startedCompleted) {
      state.phase = 'migrating'
    }
    const processed = new Set(state.processedFingerprints)
    let migrated = 0
    let quarantined = 0

    // 断点续跑：进行中的任务从最后完成的行 id 之后继续；
    // 已完成后的重跑从头扫描，由指纹集合去重，使重复进入的记录能留下证据。
    let safeStart = 0
    if (!startedCompleted && state.lastCompletedRowId !== null) {
      const resume =
        legacyRows.findIndex((row) => isRecord(row) && row.id === state.lastCompletedRowId) + 1
      safeStart = resume <= 0 ? 0 : resume
    }

    let index = safeStart
    let batch: { key: string; value: unknown }[] = []
    let batchDirty = false
    // 本批已落地（成功迁移或隔离）的记录数；幂等跳过不计入批大小。
    let processedInBatch = 0

    const flush = (): void => {
      if (!batchDirty) {
        return
      }
      state.lastBatchNo += 1
      if (options.failBeforeCommit?.(state.lastBatchNo)) {
        throw new Error(`模拟第 ${state.lastBatchNo} 批提交失败`)
      }
      state.updatedAt = port.now()
      // 整批一次原子写：要么完整可见，要么不可见，杜绝半迁移数据。
      port.setMany([...batch, { key: STORAGE_KEYS.state, value: clone(state) }])
      batch = []
      batchDirty = false
      processedInBatch = 0
      // 每批续租，证明本标签页仍存活。
      const renewed = port.renewLock(owner, LOCK_TTL_MS)
      if (!renewed) {
        throw new Error('迁移锁已被其他标签页接管，本批之后停止提交')
      }
    }

    while (index < legacyRows.length) {
      const row = legacyRows[index]
      index += 1
      const rowFingerprint = fingerprint(row)
      if (processed.has(rowFingerprint)) {
        // 同一记录反复进入迁移：只保留一个版本，留证但不新增正式版本。
        state = appendRepeatedEvidence(state, rowFingerprint, port.now())
        batchDirty = true
        batch.push({ key: STORAGE_KEYS.state, value: clone(state) })
        continue
      }

      const converted = convertLegacyRecord(row, { version: state.nextVersion, now: port.now() })
      if (converted.ok) {
        state.contracts.push(converted.contract)
        state.nextVersion += 1
        migrated += 1
      } else {
        const q: QuarantineRecord = {
          ...converted.quarantine,
          quarantineId: `Q-${String(state.nextQuarantineSeq).padStart(4, '0')}`,
          originBatch: state.lastBatchNo + 1,
        }
        state.quarantine.push(q)
        state.nextQuarantineSeq += 1
        quarantined += 1
      }

      processed.add(rowFingerprint)
      state.processedFingerprints = [...processed]
      state.lastCompletedRowId = isRecord(row) && typeof row.id === 'number' ? row.id : state.lastCompletedRowId
      batchDirty = true
      processedInBatch += 1
      batch.push({ key: STORAGE_KEYS.state, value: clone(state) })

      if (processedInBatch >= batchSize) {
        flush()
      }
    }

    // 收尾批：全部处理完才把阶段切成 completed（读新契约的唯一开关）。
    flush()
    state.phase = 'completed'
    state.updatedAt = port.now()
    port.set(STORAGE_KEYS.state, clone(state))

    return { state: clone(state), migrated, quarantined, skippedByLock: false }
  } finally {
    port.releaseLock(owner)
  }
}

/** 幂等：重复指纹只追加留证，不新增契约、不占版本号。 */
function appendRepeatedEvidence(state: MigrationState, fp: string, now: number): MigrationState {
  const target = state.contracts.find((contract) => contract.sourceFingerprint === fp)
  if (target) {
    target.evidence.push(
      evidence('REPEATED_MIGRATION', `记录指纹 ${fp} 已迁移为版本 v${target.version}，本次跳过`, fp, now),
    )
  } else {
    const q = state.quarantine.find((item) => item.sourceFingerprint === fp)
    if (q) {
      q.evidence.push(
        evidence('REPEATED_MIGRATION', `隔离记录 ${q.quarantineId} 再次进入迁移，保持单一留证`, fp, now),
      )
    }
  }
  state.updatedAt = now
  return state
}

// ---------------------------------------------------------------------------
// 读取方登记与旧键清理
// ---------------------------------------------------------------------------

/** 读取方（页面）登记自己已切换到新契约；旧键清理需等所有读取方就绪。 */
export function registerReader(port: StoragePort, readerId: string): string[] {
  const readers = new Set(port.get<string[]>(STORAGE_KEYS.readers) ?? [])
  readers.add(readerId)
  port.set(STORAGE_KEYS.readers, [...readers])
  return [...readers]
}

export function unregisterReader(port: StoragePort, readerId: string): string[] {
  const readers = new Set(port.get<string[]>(STORAGE_KEYS.readers) ?? [])
  readers.delete(readerId)
  port.set(STORAGE_KEYS.readers, [...readers])
  return [...readers]
}

export function activeReaders(port: StoragePort): string[] {
  return port.get<string[]>(STORAGE_KEYS.readers) ?? []
}

/**
 * 仅当迁移已完成、且所有登记过的读取方都已切换时，才允许清理旧键。
 * 返回是否执行了清理。
 */
export function cleanupLegacyKeyIfReady(port: StoragePort): boolean {
  const state = loadState(port)
  if (state.phase !== 'completed') {
    return false
  }
  const readers = activeReaders(port)
  if (readers.length === 0) {
    // 没有任何读取方登记过，说明新契约页面尚未接管，不能删旧键。
    return false
  }
  port.remove(LEGACY_ENTRIES_KEY)
  return true
}

// ---------------------------------------------------------------------------
// 迁移期写回：不符合新结构则保留为待转换并阻止发布
// ---------------------------------------------------------------------------

/**
 * 旧页面在迁移期间写回的数据：
 * - 已经是 v2 契约结构：纳入正式契约（不影响既有版本号顺序，追加新版本）；
 * - 否则：原样保留为待转换记录，调用方据此阻止其发布。
 */
export function acceptMigrationWrite(
  port: StoragePort,
  incoming: unknown,
): { accepted: boolean; pendingId: string | null; reason: string } {
  const now = port.now()
  const state = loadState(port)
  const fp = fingerprint(incoming)

  if (isV2Contract(incoming)) {
    if (state.processedFingerprints.includes(fp)) {
      return { accepted: true, pendingId: null, reason: '记录已存在，按幂等忽略重复写回' }
    }
    const contract: DatasetContract = { ...incoming, version: state.nextVersion, sourceFingerprint: fp, migratedAt: now }
    state.contracts.push(contract)
    state.nextVersion += 1
    state.processedFingerprints.push(fp)
    state.updatedAt = now
    port.set(STORAGE_KEYS.state, clone(state))
    return { accepted: true, pendingId: null, reason: `已纳入正式契约 v${contract.version}` }
  }

  const pendingId = `P-${String(state.nextPendingSeq).padStart(4, '0')}`
  const record: PendingConversion = {
    pendingId,
    sourceFingerprint: fp,
    evidence: [
      evidence('PENDING_CONVERSION', '迁移期写回的数据不符合 v2 结构，已保留为待转换并阻止发布', incoming, now),
    ],
    raw: clone(incoming),
    at: now,
  }
  state.pending.push(record)
  state.nextPendingSeq += 1
  state.updatedAt = now
  port.set(STORAGE_KEYS.state, clone(state))
  return { accepted: false, pendingId, reason: '数据不符合新结构，已隔离为待转换记录，禁止发布' }
}

function isV2Contract(value: unknown): value is DatasetContract {
  return (
    isRecord(value) &&
    value.schemaVersion === CONTRACT_SCHEMA_VERSION &&
    Array.isArray(value.fields) &&
    typeof value.version === 'number'
  )
}
