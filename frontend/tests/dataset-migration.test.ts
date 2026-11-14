import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  STORAGE_KEYS,
  LEGACY_ENTRIES_KEY,
  acceptMigrationWrite,
  activeReaders,
  cleanupLegacyKeyIfReady,
  convertLegacyRecord,
  createInitialState,
  fingerprint,
  loadState,
  parseFieldList,
  registerReader,
  runMigration,
} from '../src/data/dataset-migration'
import { createMemoryPort } from './memory-port'

const NOW = 1_700_000_000_000

function legacyRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    status: '草稿',
    pending: true,
    abnormal: false,
    数据集编号: 'DATA-0001',
    数据集名称: '订单数据集',
    来源表名: 'ods_orders',
    字段列表: 'order_id:bigint,amount:decimal,remark',
    更新策略: '全量覆盖',
    数据采样比例: '100%',
    生命周期天数: '30',
    缓存开关: '开',
    ...overrides,
  }
}

describe('parseFieldList 字段列表解析', () => {
  it('保留原始字段顺序并解析 name:type', () => {
    const { fields, evidences } = parseFieldList('order_id:bigint,amount:decimal,remark', NOW)
    assert.deepEqual(fields.map((f) => f.name), ['order_id', 'amount', 'remark'])
    assert.equal(fields[0].type, 'bigint')
    assert.equal(fields[0].confirmed, true)
    // remark 没有类型 -> 类型为空留证、未确认
    assert.equal(fields[2].type, null)
    assert.equal(fields[2].confirmed, false)
    assert.ok(evidences.some((e) => e.code === 'FIELD_TYPE_EMPTY'))
  })

  it('字段名含逗号单独留证', () => {
    const { fields, evidences } = parseFieldList('"省,市":string,year:int', NOW)
    assert.equal(fields[0].name, '省,市')
    assert.ok(evidences.some((e) => e.code === 'FIELD_NAME_WITH_COMMA'))
    assert.deepEqual(fields.map((f) => f.name), ['省,市', 'year'])
  })

  it('类型为空（冒号后空白）留 FIELD_TYPE_EMPTY', () => {
    const { fields, evidences } = parseFieldList('a:,b:int', NOW)
    assert.equal(fields[0].type, null)
    assert.equal(fields[0].confirmed, false)
    assert.ok(evidences.some((e) => e.code === 'FIELD_TYPE_EMPTY'))
  })
})

describe('convertLegacyRecord 单条转换', () => {
  it('来源表名、更新策略、字段顺序、指纹都保留', () => {
    const result = convertLegacyRecord(legacyRow(), { version: 1, now: NOW })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const { contract } = result
    assert.equal(contract.schemaVersion, 2)
    assert.equal(contract.version, 1)
    assert.equal(contract.sourceTable, 'ods_orders')
    assert.equal(contract.updateStrategy, '全量覆盖')
    assert.deepEqual(contract.fields.map((f) => f.name), ['order_id', 'amount', 'remark'])
    assert.equal(contract.lifecycleDays, 30)
    assert.equal(contract.sourceFingerprint, fingerprint(legacyRow()))
  })

  it('缺字段标未确认而不是补默认值', () => {
    const row = legacyRow({ 来源表名: '', 更新策略: undefined, 生命周期天数: '' })
    const result = convertLegacyRecord(row, { version: 2, now: NOW })
    assert.equal(result.ok, true)
    if (!result.ok) return
    const { contract } = result
    assert.equal(contract.sourceTable, null)
    assert.equal(contract.sourceTableConfirmed, false)
    assert.equal(contract.updateStrategy, null)
    assert.equal(contract.updateStrategyConfirmed, false)
    assert.equal(contract.lifecycleDays, null)
    assert.equal(contract.lifecycleConfirmed, false)
    assert.equal(contract.confirmed, false)
    const codes = contract.evidence.map((e) => e.code)
    assert.ok(codes.includes('MISSING_FIELD'))
  })

  it('生命周期天数非法（0、负数、非数字）留证且未确认', () => {
    for (const bad of ['0', '-3', 'abc']) {
      const result = convertLegacyRecord(legacyRow({ 生命周期天数: bad }), { version: 3, now: NOW })
      assert.equal(result.ok, true)
      if (!result.ok) return
      assert.equal(result.contract.lifecycleDays, null)
      assert.equal(result.contract.lifecycleConfirmed, false)
      assert.ok(result.contract.evidence.some((e) => e.code === 'LIFECYCLE_DAYS_INVALID'))
    }
  })

  it('字段名含逗号、类型为空分别留证但记录仍迁移', () => {
    const result = convertLegacyRecord(
      legacyRow({ 字段列表: '"省,市":,amount:decimal' }),
      { version: 4, now: NOW },
    )
    assert.equal(result.ok, true)
    if (!result.ok) return
    const codes = result.contract.evidence.map((e) => e.code)
    assert.ok(codes.includes('FIELD_NAME_WITH_COMMA'))
    assert.ok(codes.includes('FIELD_TYPE_EMPTY'))
  })

  it('无法解析的内容隔离，不产出正式契约', () => {
    const result = convertLegacyRecord({ foo: 'bar' }, { version: 5, now: NOW })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.quarantine.reason, 'UNPARSEABLE_RECORD')
    assert.deepEqual(result.quarantine.raw, { foo: 'bar' })
  })
})

describe('runMigration 批量迁移', () => {
  it('分批原子提交，正式版本号连续，隔离记录不占版本号', () => {
    const port = createMemoryPort({ now: NOW })
    const rows = [
      legacyRow({ id: 1 }),
      legacyRow({ id: 2, 字段列表: 'a:bigint,b:string' }),
      { notAnRecord: true }, // 无法解析 -> 隔离
      legacyRow({ id: 3, 生命周期天数: 'bad' }),
    ]
    const result = runMigration(port, rows, { batchSize: 2 })
    assert.equal(result.migrated, 3)
    assert.equal(result.quarantined, 1)
    const state = loadState(port)
    assert.equal(state.phase, 'completed')
    assert.deepEqual(state.contracts.map((c) => c.version), [1, 2, 3])
    assert.equal(state.quarantine[0].quarantineId, 'Q-0001')
    assert.equal(state.nextVersion, 4)
    assert.equal(state.quarantine[0].originBatch, 2)
  })

  it('中途失败后从最后完成的数据集继续（断点续跑）', () => {
    const port = createMemoryPort({ now: NOW })
    const rows = [
      legacyRow({ id: 1 }),
      legacyRow({ id: 2 }),
      legacyRow({ id: 3 }),
      legacyRow({ id: 4 }),
      legacyRow({ id: 5 }),
    ]
    // 第一批（2 条）成功，第二批提交失败。
    port.setFailSetManyAt(2)
    assert.throws(() => runMigration(port, rows, { batchSize: 2 }))
    let state = loadState(port)
    assert.equal(state.phase, 'migrating')
    assert.equal(state.contracts.length, 2)
    assert.equal(state.lastCompletedRowId, 2)
    assert.equal(state.lastBatchNo, 1)

    // 恢复：从 id=2 之后继续，不重复迁移前两条。
    port.setFailSetManyAt(undefined)
    const resumed = runMigration(port, rows, { batchSize: 2 })
    assert.equal(resumed.migrated, 3)
    state = loadState(port)
    assert.equal(state.phase, 'completed')
    assert.equal(state.contracts.length, 5)
    assert.deepEqual(state.contracts.map((c) => c.sourceRowId), [1, 2, 3, 4, 5])
    assert.deepEqual(state.contracts.map((c) => c.version), [1, 2, 3, 4, 5])
  })

  it('同一记录反复迁移只保留一个版本并留 REPEATED_MIGRATION 证据', () => {
    const port = createMemoryPort({ now: NOW })
    const rows = [legacyRow({ id: 1 }), legacyRow({ id: 2 })]
    runMigration(port, rows, { batchSize: 5 })
    const before = loadState(port)
    assert.equal(before.contracts.length, 2)

    const again = runMigration(port, rows, { batchSize: 5 })
    assert.equal(again.migrated, 0)
    const after = loadState(port)
    assert.equal(after.contracts.length, 2)
    assert.equal(after.nextVersion, 3)
    assert.ok(after.contracts[0].evidence.some((e) => e.code === 'REPEATED_MIGRATION'))
  })

  it('保留原记录指纹，清空缓存后从最后成功批次重建不回填重复记录', () => {
    const port = createMemoryPort({ now: NOW })
    const rows = [legacyRow({ id: 1 }), legacyRow({ id: 2 })]
    runMigration(port, rows, { batchSize: 1 })
    const state = loadState(port)
    assert.equal(state.contracts[0].sourceFingerprint, fingerprint(rows[0]))

    // 模拟「清空页面缓存」：状态仍持久化在存储里，重新 loadState 即重建。
    const rebuilt = loadState(port)
    assert.equal(rebuilt.contracts.length, 2)
    // 重建后再次迁移，幂等不产生重复契约。
    const rerun = runMigration(port, rows, { batchSize: 1 })
    assert.equal(rerun.migrated, 0)
    assert.equal(loadState(port).contracts.length, 2)
  })

  it('两个标签页同时迁移：第二个拿不到锁，跳过且不提交批次', () => {
    // 两个端口共享同一份底层存储与时钟，模拟同一浏览器的两个标签页。
    const sharedStore = new Map<string, unknown>()
    const sharedClock = { value: NOW }
    const portA = createMemoryPort({ sharedStore, sharedClock })
    const portB = createMemoryPort({ sharedStore, sharedClock })
    // 让 A 先持有锁。
    const lock = portA.acquireLock('tab-A', 60_000)
    assert.ok(lock)
    const rows = [legacyRow({ id: 1 })]
    const resultB = runMigration(portB, rows, { batchSize: 1 })
    assert.equal(resultB.skippedByLock, true)
    assert.equal(resultB.migrated, 0)
    // B 没有写入任何迁移状态。
    assert.equal(loadState(portB).phase, 'idle')

    // A 释放锁后，B 可以独立完成整批，证明互斥不影响正常提交。
    portA.releaseLock('tab-A')
    const resultB2 = runMigration(portB, rows, { batchSize: 1 })
    assert.equal(resultB2.skippedByLock, false)
    assert.equal(resultB2.migrated, 1)
    assert.equal(loadState(portB).phase, 'completed')
  })

  it('失败的转换结果不占用正式版本号', () => {
    const port = createMemoryPort({ now: NOW })
    const rows = [
      { junk: 1 }, // 隔离
      legacyRow({ id: 1 }),
      { junk: 2 }, // 隔离
      legacyRow({ id: 2 }),
    ]
    runMigration(port, rows, { batchSize: 10 })
    const state = loadState(port)
    assert.deepEqual(state.contracts.map((c) => c.version), [1, 2])
    assert.deepEqual(state.quarantine.map((q) => q.quarantineId), ['Q-0001', 'Q-0002'])
  })
})

describe('迁移期写回与发布拦截', () => {
  it('不符合新结构的写回保留为待转换记录并标记阻止发布', () => {
    const port = createMemoryPort({ now: NOW })
    runMigration(port, [legacyRow({ id: 1 })], { batchSize: 5 })
    const flatWrite = legacyRow({ id: 99, 来源表名: '' })
    const result = acceptMigrationWrite(port, flatWrite)
    assert.equal(result.accepted, false)
    assert.ok(result.pendingId?.startsWith('P-'))
    const state = loadState(port)
    assert.equal(state.pending.length, 1)
    assert.equal(state.pending[0].evidence[0].code, 'PENDING_CONVERSION')
    // 待转换不占正式版本号。
    assert.equal(state.nextVersion, 2)
  })

  it('符合 v2 结构的写回纳入正式契约并分配连续版本号', () => {
    const port = createMemoryPort({ now: NOW })
    runMigration(port, [legacyRow({ id: 1 })], { batchSize: 5 })
    const state = loadState(port)
    const v2 = state.contracts[0]
    const incoming = { ...v2, version: 999, datasetCode: 'DATA-NEW' }
    const result = acceptMigrationWrite(port, incoming)
    assert.equal(result.accepted, true)
    const after = loadState(port)
    // 外部自带版本号被忽略，统一由引擎续号。
    assert.equal(after.contracts[1].version, 2)
  })
})

describe('读旧/读新切换与旧键清理', () => {
  it('迁移完成前阶段为 migrating，完成后才 completed', () => {
    const port = createMemoryPort({ now: NOW })
    port.setFailSetManyAt(2) // 第一批成功、第二批失败
    const rows = [legacyRow({ id: 1 }), legacyRow({ id: 2 }), legacyRow({ id: 3 })]
    assert.throws(() => runMigration(port, rows, { batchSize: 1 }))
    assert.equal(loadState(port).phase, 'migrating')
    port.setFailSetManyAt(undefined)
    runMigration(port, rows, { batchSize: 1 })
    assert.equal(loadState(port).phase, 'completed')
  })

  it('所有读取方切换后才清理旧键，未就绪不清理', () => {
    const port = createMemoryPort({ now: NOW })
    port.set(LEGACY_ENTRIES_KEY, { datastore: [legacyRow()] })
    runMigration(port, [legacyRow()], { batchSize: 5 })

    // 没有读取方登记 -> 不清理。
    assert.equal(cleanupLegacyKeyIfReady(port), false)
    assert.ok(port.get(LEGACY_ENTRIES_KEY))

    registerReader(port, 'query-view')
    assert.equal(activeReaders(port).length, 1)
    assert.equal(cleanupLegacyKeyIfReady(port), true)
    assert.equal(port.get(LEGACY_ENTRIES_KEY), null)
  })

  it('迁移未完成时即使有读取方也不清理旧键', () => {
    const port = createMemoryPort({ now: NOW })
    port.set(LEGACY_ENTRIES_KEY, { datastore: [legacyRow()] })
    const state = createInitialState(NOW)
    state.phase = 'migrating'
    port.set(STORAGE_KEYS.state, state)
    registerReader(port, 'query-view')
    assert.equal(cleanupLegacyKeyIfReady(port), false)
    assert.ok(port.get(LEGACY_ENTRIES_KEY))
  })
})

describe('指纹稳定性', () => {
  it('相同内容指纹一致，不同内容不同', () => {
    const a = legacyRow()
    const b = legacyRow()
    assert.equal(fingerprint(a), fingerprint(b))
    const c = legacyRow({ id: 2 })
    assert.notEqual(fingerprint(a), fingerprint(c))
  })
})
