/**
 * 内存版 StoragePort：只用于 Node 测试，模拟 localStorage 的语义，
 * 并额外提供 snapshot / setNow / failNextCommit 等测试钩子。
 */
import type { StorageLockInfo, StoragePort } from '../src/data/dataset-migration'

export interface MemoryPortOptions {
  now?: number
  /** 让第 N 次 setMany 抛错（模拟批次提交中途失败）。 */
  failSetManyAt?: number
  /** 多个「标签页」端口可传入同一个 Map 来共享底层存储。 */
  sharedStore?: Map<string, unknown>
  /** 共享时钟（多标签页场景）。 */
  sharedClock?: { value: number }
}

export function createMemoryPort(options: MemoryPortOptions = {}): StoragePort & {
  snapshot: () => Map<string, unknown>
  setNow: (value: number) => void
  setFailSetManyAt: (value: number | undefined) => void
  writeCount: () => number
} {
  const store = options.sharedStore ?? new Map<string, unknown>()
  const listeners = new Set<() => void>()
  const clock = options.sharedClock ?? { value: options.now ?? 1_700_000_000_000 }
  let failAt = options.failSetManyAt
  let writes = 0

  const port = {
    get<T>(key: string): T | null {
      return (store.has(key) ? (JSON.parse(JSON.stringify(store.get(key))) as T) : null)
    },
    set(key: string, value: unknown): void {
      store.set(key, JSON.parse(JSON.stringify(value)))
      listeners.forEach((listener) => listener())
    },
    setMany(entries: { key: string; value: unknown }[]): void {
      writes += 1
      if (failAt !== undefined && writes === failAt) {
        throw new Error('内存存储：模拟批次原子写失败')
      }
      const snapshot = entries.map(({ key }) => ({ key, value: store.has(key) ? store.get(key) : undefined }))
      try {
        for (const { key, value } of entries) {
          store.set(key, JSON.parse(JSON.stringify(value)))
        }
      } catch (error) {
        for (const { key, value } of snapshot) {
          if (value === undefined) {
            store.delete(key)
          } else {
            store.set(key, value)
          }
        }
        throw error
      }
      listeners.forEach((listener) => listener())
    },
    remove(key: string): void {
      store.delete(key)
      listeners.forEach((listener) => listener())
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    readLock(): StorageLockInfo | null {
      const lock = store.get('interactive-analytics-lab:dataset-migration:lock') as StorageLockInfo | undefined
      if (!lock || lock.expiresAt <= clock.value) {
        return undefined as never
      }
      return lock
    },
    acquireLock(owner: string, ttlMs: number): StorageLockInfo | null {
      const existing = this.readLock()
      if (existing && existing.owner !== owner) {
        return null
      }
      const lock: StorageLockInfo = { owner, acquiredAt: clock.value, expiresAt: clock.value + ttlMs }
      store.set('interactive-analytics-lab:dataset-migration:lock', lock)
      return lock
    },
    renewLock(owner: string, ttlMs: number): StorageLockInfo | null {
      const existing = this.readLock()
      if (!existing || existing.owner !== owner) {
        return null
      }
      const lock: StorageLockInfo = { owner, acquiredAt: existing.acquiredAt, expiresAt: clock.value + ttlMs }
      store.set('interactive-analytics-lab:dataset-migration:lock', lock)
      return lock
    },
    releaseLock(owner: string): void {
      const existing = this.readLock()
      if (existing && existing.owner === owner) {
        store.delete('interactive-analytics-lab:dataset-migration:lock')
      }
    },
    now(): number {
      return clock.value
    },
    snapshot(): Map<string, unknown> {
      return new Map(store)
    },
    setNow(value: number): void {
      clock.value = value
    },
    setFailSetManyAt(value: number | undefined): void {
      failAt = value
    },
    writeCount(): number {
      return writes
    },
  }

  return port
}
