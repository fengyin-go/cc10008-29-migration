/**
 * 数据集定义的统一访问层（两个入口共用一套写法）：
 * - 写侧「数据集管理」页面：触发/观察迁移、展示契约与隔离留证、拦截发布；
 * - 读侧「交互查询」页面：迁移完成前读旧契约，完成后才读迁移后的字段契约。
 *
 * 页面组件不再各自适配扁平记录，全部走这里，保证读写口径一致、可回读旧契约。
 */

import { createBrowserStoragePort } from './browser-storage-port'
import {
  acceptMigrationWrite,
  activeReaders,
  cleanupLegacyKeyIfReady,
  loadState,
  registerReader,
  runMigration,
  unregisterReader,
  LEGACY_DATASET_MODULE,
  type DatasetContract,
  type MigrationPhase,
  type MigrationRunResult,
  type MigrationState,
  type StoragePort,
} from './dataset-migration'
import { getStoredEntriesRaw, rebuildCacheFromStorage } from './local-store'
import type { EntryRow } from './types'

let port: StoragePort | null = null

/** 单例端口：同页面共享锁与迁移状态。 */
export function datasetPort(): StoragePort {
  if (!port) {
    port = createBrowserStoragePort()
  }
  return port
}

/** 测试注入：用内存端口替换浏览器端口（生产代码不调用）。 */
export function __setDatasetPort(custom: StoragePort): void {
  port = custom
}

// ---------------------------------------------------------------------------
// 迁移状态与触发
// ---------------------------------------------------------------------------

export function getMigrationState(): MigrationState {
  return loadState(datasetPort())
}

export function getMigrationPhase(): MigrationPhase {
  return getMigrationState().phase
}

/** 读取旧版扁平数据集记录（迁移源数据）。 */
export function getLegacyDatasetRows(): EntryRow[] {
  const entries = getStoredEntriesRaw()
  return Array.isArray(entries[LEGACY_DATASET_MODULE]) ? entries[LEGACY_DATASET_MODULE] : []
}

/**
 * 触发迁移：两个入口共用同一步骤。
 * 中途失败后再次调用，会从最后完成的数据集继续（断点续跑）。
 */
export function startMigration(batchSize?: number): MigrationRunResult {
  const rows = getLegacyDatasetRows()
  return runMigration(datasetPort(), rows, { batchSize })
}

export function subscribeMigration(listener: () => void): () => void {
  return datasetPort().subscribe(listener)
}

// ---------------------------------------------------------------------------
// 读侧：交互查询读取字段契约
// ---------------------------------------------------------------------------

/** 查询页可用的数据集字段视图：字段名顺序即原始字段顺序。 */
export interface QueryDatasetOption {
  datasetCode: string
  name: string
  sourceTable: string | null
  updateStrategy: string | null
  /** 字段名（保留原始顺序）。 */
  fieldNames: string[]
  /** 是否存在未确认字段（类型为空等）。 */
  hasUnconfirmedFields: boolean
  confirmed: boolean
}

function contractToQueryOption(contract: DatasetContract): QueryDatasetOption {
  return {
    datasetCode: contract.datasetCode,
    name: contract.name,
    sourceTable: contract.sourceTable,
    updateStrategy: contract.updateStrategy,
    fieldNames: contract.fields.map((field) => field.name),
    hasUnconfirmedFields: contract.fields.some((field) => !field.confirmed),
    confirmed: contract.confirmed,
  }
}

/** 旧契约回读：迁移完成前，查询仍按旧逗号字符串解析字段。 */
function legacyToQueryOption(row: EntryRow): QueryDatasetOption {
  const raw = String(row['字段列表'] ?? '')
  const fieldNames = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '')
  return {
    datasetCode: String(row['数据集编号'] ?? `DATA-${row.id}`),
    name: String(row['数据集名称'] ?? `未命名数据集-${row.id}`),
    sourceTable: row['来源表名'] === undefined ? null : String(row['来源表名']),
    updateStrategy: row['更新策略'] === undefined ? null : String(row['更新策略']),
    fieldNames,
    // 旧契约本身无法校验，统一视为未确认，提示迁移后再依赖。
    hasUnconfirmedFields: true,
    confirmed: false,
  }
}

/**
 * 交互查询读取数据集字段契约的唯一入口：
 * - idle/migrating：读旧契约（旧逗号字符串），保证迁移期不读到半迁移数据；
 * - completed：读迁移后的结构化字段契约。
 */
export function getQueryDatasetOptions(): { phase: MigrationPhase; options: QueryDatasetOption[] } {
  const state = getMigrationState()
  if (state.phase === 'completed') {
    return {
      phase: state.phase,
      options: state.contracts.map(contractToQueryOption),
    }
  }
  return { phase: state.phase, options: getLegacyDatasetRows().map(legacyToQueryOption) }
}

/** 读取方登记：查询页挂载时登记已具备新契约读取能力。 */
export function markReaderReady(readerId: string): string[] {
  return registerReader(datasetPort(), readerId)
}

export function markReaderGone(readerId: string): string[] {
  return unregisterReader(datasetPort(), readerId)
}

export function getActiveReaders(): string[] {
  return activeReaders(datasetPort())
}

/**
 * 所有读取方都切换后才清理旧键；未就绪则不动旧数据。
 * 返回是否真正清理。
 */
export function tryCleanupLegacy(): boolean {
  return cleanupLegacyKeyIfReady(datasetPort())
}

// ---------------------------------------------------------------------------
// 写侧：迁移期写回拦截
// ---------------------------------------------------------------------------

export interface WriteGuardResult {
  allowed: boolean
  reason: string
  pendingId: string | null
}

/**
 * 数据集「生效发布」守卫：
 * 迁移期或迁移后，写回内容不符合 v2 结构的，保留为待转换记录并阻止发布。
 */
export function guardDatasetPublish(incoming: unknown): WriteGuardResult {
  const result = acceptMigrationWrite(datasetPort(), incoming)
  return { allowed: result.accepted, reason: result.reason, pendingId: result.pendingId }
}

/**
 * 判断一条待发布的数据集定义是否满足新结构。
 * 迁移开始后（migrating/completed），发布动作必须先过这个守卫；
 * 不满足的写回会被 acceptMigrationWrite 留为待转换记录，且这里返回 false 阻止发布。
 */
export function canPublishDataset(row: EntryRow): WriteGuardResult {
  const phase = getMigrationPhase()
  if (phase === 'idle') {
    // 迁移尚未启动，沿用旧流程，不拦截。
    return { allowed: true, reason: '迁移尚未启动，沿用旧契约发布', pendingId: null }
  }
  const looksStructured =
    typeof row['来源表名'] === 'string' &&
    row['来源表名'].trim() !== '' &&
    typeof row['更新策略'] === 'string' &&
    row['更新策略'].trim() !== '' &&
    typeof row['字段列表'] === 'string' &&
    row['字段列表'].trim() !== ''
  if (!looksStructured) {
    // 不符合新结构：保留为待转换并阻止发布。
    return guardDatasetPublish(row)
  }
  // 结构达标，放行真正的状态流转；记录本身不重复入库。
  return { allowed: true, reason: '符合新结构，允许发布', pendingId: null }
}

// ---------------------------------------------------------------------------
// 页面缓存清空后重建：从最后成功批次恢复，不回填重复记录
// ---------------------------------------------------------------------------

/**
 * 清空内存缓存并从已持久化的最后成功批次重建。
 * 迁移状态按指纹幂等，重建后再次迁移也不会产生重复契约或重复版本号。
 */
export function rebuildAfterCacheClear(): MigrationState {
  rebuildCacheFromStorage()
  return getMigrationState()
}
