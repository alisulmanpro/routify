import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { AuditLogRow } from '../lib/types';
import { dateTime, titleCase } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import { useToast } from '../components/Toast';

export default function AuditLogs() {
  const toast = useToast();
  const [rows, setRows] = useState<AuditLogRow[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    get<AuditLogRow[]>('/admin/audit-logs', { page, limit: 30, search: search || undefined })
      .then((r) => { setRows(r.data); setPages(r.meta?.pages || 1); })
      .catch((e) => toast('error', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Audit log</h1><p className="heading-copy">Every administrative action and login attempt, most recent first.</p></div></div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <input className="input table-search" placeholder="Search actor, action, target…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="text-button" type="submit">Search</button>
      </form>

      <div className="panel module-table">
        {loading ? <div className="loading-state">Loading…</div> : rows.length === 0 ? <div className="module-empty-copy">No audit events found.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Target</th><th>Status</th><th>IP</th></tr></thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={l.id}>
                    <td>{dateTime(l.createdAt)}</td><td>{l.actorEmail || 'System'}</td><td>{titleCase(l.action)}</td>
                    <td>{l.targetType ? `${titleCase(l.targetType)} · ${l.targetId}` : '—'}</td>
                    <td><StatusBadge value={l.status} /></td><td>{l.ip || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} onChange={setPage} />
      </div>
    </section>
  );
}
