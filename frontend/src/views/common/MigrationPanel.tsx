import type { MigrationState } from '@/data/dataset-migration'

interface MigrationPanelProps {
  state: MigrationState
  busy: boolean
  message: string
  onRun: () => void
  onCleanup: () => void
  onRebuild: () => void
  /** 读取方数量，决定旧键能否清理。 */
  readerCount: number
}

const PHASE_TEXT: Record<MigrationState['phase'], string> = {
  idle: '未开始（查询仍读旧契约）',
  migrating: '迁移中（查询继续读旧契约，不读半迁移数据）',
  completed: '已完成（查询已切换到字段契约 v2）',
}

/** 两个入口共用的迁移控制台：进度、隔离留证、待转换记录、清理与重建。 */
export default function MigrationPanel({
  state,
  busy,
  message,
  onRun,
  onCleanup,
  onRebuild,
  readerCount,
}: MigrationPanelProps) {
  const total = state.contracts.length + state.quarantine.length
  return (
    <section className="migration-panel" data-phase={state.phase}>
      <header className="migration-head">
        <div>
          <h3>数据集定义迁移（v1 扁平记录 → v2 字段契约）</h3>
          <p className="page-desc">阶段：{PHASE_TEXT[state.phase]}</p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" disabled={busy || state.phase === 'completed'} onClick={onRun}>
            {state.phase === 'idle' ? '开始迁移' : '继续迁移（断点续跑）'}
          </button>
          <button className="btn" type="button" onClick={onRebuild}>清空缓存并重建</button>
          <button
            className="btn ghost"
            type="button"
            disabled={state.phase !== 'completed' || readerCount === 0}
            onClick={onCleanup}
          >
            清理旧键
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">已处理记录</span>
          <strong className="stat-value">{total}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">正式契约（版本号连续）</span>
          <strong className="stat-value">{state.contracts.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">隔离留证（不占版本号）</span>
          <strong className="stat-value">{state.quarantine.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待转换（禁止发布）</span>
          <strong className="stat-value">{state.pending.length}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已提交批次</span>
          <strong className="stat-value">{state.lastBatchNo}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">最后完成行 id</span>
          <strong className="stat-value">{state.lastCompletedRowId ?? '—'}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已切换读取方</span>
          <strong className="stat-value">{readerCount}</strong>
        </article>
      </div>

      {message && <p className="error-text">{message}</p>}

      {state.quarantine.length > 0 && (
        <details className="migration-details">
          <summary>隔离留证（{state.quarantine.length}）：无法解析 / 字段名含逗号 / 类型为空 / 天数非法</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>隔离编号</th>
                <th>来源行 id</th>
                <th>原因</th>
                <th>留证说明</th>
                <th>来源批次</th>
              </tr>
            </thead>
            <tbody>
              {state.quarantine.map((item) => (
                <tr key={item.quarantineId}>
                  <td>{item.quarantineId}</td>
                  <td>{item.sourceRowId ?? '—'}</td>
                  <td>{item.reason}</td>
                  <td>{item.evidence.map((e) => e.message).join('；')}</td>
                  <td>{item.originBatch}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {state.pending.length > 0 && (
        <details className="migration-details">
          <summary>待转换记录（{state.pending.length}，已阻止发布）</summary>
          <table className="data-table">
            <thead>
              <tr>
                <th>待转换编号</th>
                <th>指纹</th>
                <th>留证说明</th>
              </tr>
            </thead>
            <tbody>
              {state.pending.map((item) => (
                <tr key={item.pendingId}>
                  <td>{item.pendingId}</td>
                  <td>{item.sourceFingerprint}</td>
                  <td>{item.evidence.map((e) => e.message).join('；')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </section>
  )
}
