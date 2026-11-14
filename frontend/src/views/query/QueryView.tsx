import { useCallback, useEffect, useMemo, useState } from 'react'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { getQueryDatasetOptions, markReaderGone, markReaderReady } from '@/data/dataset-service'
import type { EntryRow } from '@/data/types'
import { useMigrationStatus } from '../common/useMigrationStatus'

const meta = moduleMeta('query')
const columns = [
  "语句编号",
  "查询表达式",
  "目标数据集",
  "返回字段",
  "排序条件",
  "分页大小",
  "最大行数",
  "超时秒数"
]
const actions = [
  "提交执行",
  "启动查询",
  "终止查询",
  "保存结果"
]
const statuses = [
  "草稿",
  "待执行",
  "执行中",
  "已完成",
  "已超时"
]
const stats = [
  {
    "label": "查询语句总数",
    "value": 0
  },
  {
    "label": "已完成查询",
    "value": 0
  },
  {
    "label": "执行中查询",
    "value": 0
  }
]

const READER_ID = 'query-view'

export default function QueryView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const filterFields = useMemo(() => columns.slice(0, 3), [])
  const { state: migration, refresh } = useMigrationStatus()

  // 交互查询读取的数据集字段契约：完成前读旧契约，完成后读 v2 契约。
  const datasetPayload = useMemo(
    () => getQueryDatasetOptions(),
    // migration 变化即重新选择契约来源，避免读到半迁移数据。
    [migration.phase, migration.contracts.length, migration.updatedAt],
  )

  // 登记本页已具备新契约读取能力；卸载时注销，供旧键清理判断读取方就绪情况。
  useEffect(() => {
    markReaderReady(READER_ID)
    refresh()
    return () => {
      markReaderGone(READER_ID)
    }
  }, [refresh])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '交互查询列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    reload()
  }

  return (
    <section className="page" data-module="query">
      <header className="page-head">
        <div>
          <h2>交互查询管理</h2>
          <p className="page-desc">维护交互查询语句的输入、执行约束与结果记录，为数据查询提供可验证的数据工程流程。</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('查询语句登记入口尚未接入审批流')}>
            登记查询语句
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出交互查询清单
          </button>
        </div>
      </header>

      <section className="contract-section" data-contract-phase={datasetPayload.phase}>
        <h3>
          可查询数据集字段契约
          <span className="badge">
            {datasetPayload.phase === 'completed' ? '来源：v2 字段契约（迁移后）' : '来源：旧契约（迁移完成前只读旧版）'}
          </span>
        </h3>
        <table className="data-table">
          <thead>
            <tr>
              <th>数据集编号</th>
              <th>数据集名称</th>
              <th>来源表名</th>
              <th>更新策略</th>
              <th>返回字段（保留原始顺序）</th>
              <th>确认状态</th>
            </tr>
          </thead>
          <tbody>
            {datasetPayload.options.map((option) => (
              <tr key={option.datasetCode} data-confirmed={option.confirmed}>
                <td>{option.datasetCode}</td>
                <td>{option.name}</td>
                <td>{option.sourceTable ?? '未确认'}</td>
                <td>{option.updateStrategy ?? '未确认'}</td>
                <td>{option.fieldNames.join('、') || '—'}</td>
                <td>
                  {option.confirmed ? '已确认' : '未确认'}
                  {option.hasUnconfirmedFields && <span className="badge warn">含未确认字段</span>}
                </td>
              </tr>
            ))}
            {datasetPayload.options.length === 0 && (
              <tr>
                <td className="empty-state" colSpan={6}>暂无可查询数据集</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无交互查询数据，可先登记查询语句</td>
            </tr>
          )}
        </tbody>
      </table>

      <footer className="page-foot">
        <span>共 {total} 条交互查询记录</span>
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
