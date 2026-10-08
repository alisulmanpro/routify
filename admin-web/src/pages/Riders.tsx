import { useEffect, useState } from 'react';
import { get, patch, ApiRequestError } from '../lib/api';
import type { Rider } from '../lib/types';
import { dateShort } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import { useToast } from '../components/Toast';

export default function Riders() {
  const toast = useToast();
  const [rows, setRows] = useState<Rider[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    get<Rider[]>('/admin/riders', { page, limit: 20, search: search || undefined, status: status || undefined })
      .then((r) => { setRows(r.data); setPages(r.meta?.pages || 1); })
      .catch((e) => toast('error', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = async (rider: Rider) => {
    const next = rider.status === 'active' ? 'suspended' : 'active';
    setBusyId(rider.id);
    try {
      await patch(`/admin/riders/${rider.id}`, { status: next });
      toast('success', `${rider.fullName} ${next === 'active' ? 'reactivated' : 'suspended'}`);
      load();
    } catch (e) {
      toast('error', e instanceof ApiRequestError ? e.message : 'Update failed');
    } finally { setBusyId(null); }
  };

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Riders</h1><p className="heading-copy">Every rider on the platform — each one signs up, subscribes, and runs their own deliveries independently.</p></div></div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <input className="input table-search" placeholder="Search riders…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option value="active">Active</option><option value="suspended">Suspended</option>
        </select>
        <button className="text-button" type="submit">Search</button>
      </form>

      <div className="panel module-table">
        {loading ? <div className="loading-state">Loading…</div> : rows.length === 0 ? <div className="module-empty-copy">No riders found.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Rider</th><th>Subscription</th><th>Deliveries</th><th>Last active</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td><strong>{r.fullName}</strong><br /><small className="muted-small">{r.email}</small></td>
                    <td>{r.subscriptionStatus ? <StatusBadge value={r.subscriptionStatus} /> : '—'}</td>
                    <td>{r.deliveries}</td>
                    <td>{r.lastActiveAt ? dateShort(r.lastActiveAt) : 'Never'}</td>
                    <td><StatusBadge value={r.status} /></td>
                    <td><button className="text-button" disabled={busyId === r.id} onClick={() => toggle(r)}>{r.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td>
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
