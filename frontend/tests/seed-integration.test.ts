import assert from 'node:assert/strict'
import { test } from 'node:test'

import { SEED_ROWS } from '../src/data/seed'
import { LEGACY_DATASET_MODULE } from '../src/data/dataset-migration'
import {
  getLegacyDatasetRows,
  getQueryDatasetOptions,
  getMigrationPhase,
  startMigration,
  tryCleanupLegacy,
  markReaderReady,
  canPublishDataset,
  __setDatasetPort,
} from '../src/data/dataset-service'
import { createMemoryPort } from './memory-port'

test('真实种子数据：扁平记录迁为字段契约，查询按阶段切换读契约', () => {
  const rows = SEED_ROWS[LEGACY_DATASET_MODULE]
  assert.equal(rows.length, 3)
  // 旧记录的字段列表确实是逗号字符串。
  assert.equal(typeof rows[0]['字段列表'], 'string')

  __setDatasetPort(createMemoryPort())

  // 旧记录读取（Node 无 window 时 local-store 回落到种子数据）。
  assert.equal(getLegacyDatasetRows().length, 3)

  // 迁移前查询读旧契约。
  const before = getQueryDatasetOptions()
  assert.equal(before.phase, 'idle')
  assert.equal(before.options.length, 3)
  assert.equal(before.options[0].confirmed, false)

  const result = startMigration()
  assert.equal(result.migrated, 3)
  assert.equal(getMigrationPhase(), 'completed')

  // 迁移后查询读 v2 契约，字段顺序与旧逗号字符串一致。
  const after = getQueryDatasetOptions()
  assert.equal(after.phase, 'completed')
  assert.equal(after.options.length, 3)
  assert.deepEqual(
    after.options[0].fieldNames,
    String(rows[0]['字段列表']).split(',').map((s) => s.trim()),
  )

  // 读取方未登记前不能清理旧键，登记后才可以。
  assert.equal(tryCleanupLegacy(), false)
  markReaderReady('query-view')
  assert.equal(tryCleanupLegacy(), true)

  // 发布守卫：来源表名缺失的写回被拦截并保留为待转换记录。
  const bad = { ...rows[0], 来源表名: '' }
  const guard = canPublishDataset(bad)
  assert.equal(guard.allowed, false)
  assert.ok(guard.pendingId?.startsWith('P-'))
})
