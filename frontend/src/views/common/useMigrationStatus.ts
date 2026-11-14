import { useCallback, useEffect, useState } from 'react'

import {
  getMigrationState,
  startMigration,
  subscribeMigration,
  tryCleanupLegacy,
  rebuildAfterCacheClear,
} from '@/data/dataset-service'
import type { MigrationRunResult, MigrationState } from '@/data/dataset-migration'

/**
 * 迁移状态订阅：两个入口（数据集管理 / 交互查询）共用。
 * 跨标签页的 storage 事件会触发刷新，保证各标签页不会长期停在半迁移视图。
 */
export function useMigrationStatus() {
  const [state, setState] = useState<MigrationState>(() => getMigrationState())
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')

  const refresh = useCallback(() => {
    setState(getMigrationState())
  }, [])

  useEffect(() => subscribeMigration(refresh), [refresh])

  const run = useCallback(async () => {
    setBusy(true)
    setMessage('')
    try {
      // 让锁与 storage 事件有机会在异步边界传播，模拟真实跨标签页时序。
      await Promise.resolve()
      const result: MigrationRunResult = startMigration()
      if (result.skippedByLock) {
        setMessage('另一个标签页正在迁移，本页未提交批次（跨标签页互斥）。')
      } else {
        setMessage(`本批完成：新迁移 ${result.migrated} 条，隔离 ${result.quarantined} 条。`)
      }
      refresh()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '迁移中途失败，可再次触发从最后完成的数据集继续。')
      refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const cleanup = useCallback(() => {
    const done = tryCleanupLegacy()
    setMessage(done ? '所有读取方已切换，旧键已清理。' : '读取方尚未全部切换，保留旧键不清理。')
    refresh()
  }, [refresh])

  const rebuild = useCallback(() => {
    rebuildAfterCacheClear()
    setMessage('已从最后成功批次重建内存缓存，未回填重复记录。')
    refresh()
  }, [refresh])

  return { state, busy, message, run, cleanup, rebuild, refresh }
}
