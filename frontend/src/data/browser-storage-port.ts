/**
 * 浏览器 localStorage 版 StoragePort。
 * - 迁移状态走独立键，与旧 entries 键并存，迁移期旧契约始终可回读；
 * - setMany 用一次写循环 + 失败回滚，尽量保证批次原子可见；
 * - 锁带 TTL，标签页崩溃后锁会过期，可被其他标签页接管；
 * - 通过 storage 事件让其他标签页感知迁移状态变化。
 */

import {
  STORAGE_KEYS,
  type StorageLockInfo,
  type StoragePort,
} from './dataset-migration'

function safeParse(raw: string | null): unknown {
  if (raw === null) {
    return null
  }
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export function createBrowserStoragePort(): StoragePort {
  const listeners = new Set<() => void>()

  function notify(): void {
    listeners.forEach((listener) => listener())
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('storage', notify)
  }

  return {
    get<T>(key: string): T | null {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null
      }
      return safeParse(window.localStorage.getItem(key)) as T | null
    },

    set(key: string, value: unknown): void {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      window.localStorage.setItem(key, JSON.stringify(value))
    },

    setMany(entries: { key: string; value: unknown }[]): void {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      // 先快照所有目标键，任何一个写入失败就回滚，避免批次半落地。
      const snapshot = entries.map(({ key }) => ({
        key,
        raw: window.localStorage.getItem(key),
      }))
      try {
        for (const { key, value } of entries) {
          window.localStorage.setItem(key, JSON.stringify(value))
        }
      } catch (error) {
        for (const { key, raw } of snapshot) {
          if (raw === null) {
            window.localStorage.removeItem(key)
          } else {
            window.localStorage.setItem(key, raw)
          }
        }
        throw error
      }
    },

    remove(key: string): void {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      window.localStorage.removeItem(key)
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    readLock(): StorageLockInfo | null {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null
      }
      const lock = safeParse(window.localStorage.getItem(STORAGE_KEYS.lock)) as StorageLockInfo | null
      if (!lock) {
        return null
      }
      if (lock.expiresAt <= Date.now()) {
        window.localStorage.removeItem(STORAGE_KEYS.lock)
        return null
      }
      return lock
    },

    acquireLock(owner: string, ttlMs: number): StorageLockInfo | null {
      if (typeof window === 'undefined' || !window.localStorage) {
        return null
      }
      const existing = this.readLock()
      if (existing && existing.owner !== owner) {
        return null
      }
      const now = Date.now()
      const lock: StorageLockInfo = { owner, acquiredAt: now, expiresAt: now + ttlMs }
      window.localStorage.setItem(STORAGE_KEYS.lock, JSON.stringify(lock))
      // 再读一次确认写入未被并发标签页覆盖。
      const confirmed = safeParse(window.localStorage.getItem(STORAGE_KEYS.lock)) as StorageLockInfo | null
      if (!confirmed || confirmed.owner !== owner) {
        return null
      }
      return lock
    },

    renewLock(owner: string, ttlMs: number): StorageLockInfo | null {
      const existing = this.readLock()
      if (!existing || existing.owner !== owner) {
        return null
      }
      const now = Date.now()
      const lock: StorageLockInfo = { owner, acquiredAt: existing.acquiredAt, expiresAt: now + ttlMs }
      window.localStorage.setItem(STORAGE_KEYS.lock, JSON.stringify(lock))
      return lock
    },

    releaseLock(owner: string): void {
      if (typeof window === 'undefined' || !window.localStorage) {
        return
      }
      const existing = this.readLock()
      if (existing && existing.owner === owner) {
        window.localStorage.removeItem(STORAGE_KEYS.lock)
      }
    },

    now(): number {
      return Date.now()
    },
  }
}
