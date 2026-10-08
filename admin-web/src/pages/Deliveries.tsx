import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { Delivery } from '../lib/types';
import { dateShort, titleCase } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import { useToast } from '../components/Toast';

export default function Deliveries() {
  const toast = useToast();
  const [rows, setRows] = useState<Delivery[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    get<Delivery[]>('/admin/deliveries', { page, limit: 25, search: search || undefined, status: status || undefined, date: date || undefined })
      .then((r) => { setRows(r.data); setPages(r.meta?.pages || 1); })
      .catch((e) => toast('error', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page, status, date]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Deliveries</h1><p className="heading-copy">Every delivery across every organization, newest first.</p></div></div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <input className="input table-search" placeholder="Search parcel ID, customer, address…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setPage(1); }} />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="in_progress">In progress</option><option value="delivered">Delivered</option><option value="failed">Failed</option>
        </select>
        <button className="text-button" type="submit">Search</button>
      </form>

      <div className="panel module-table">
        {loading ? <div className="loading-state">Loading…</div> : rows.length === 0 ? <div className="module-empty-copy">No deliveries found.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Parcel ID</th><th>Customer</th><th>Rider</th><th>Address</th><th>Status</th><th>Date</th></tr></thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id}>
                    <td><strong>{d.trackingId}</strong></td>
                    <td>{d.customer.name || '—'}{d.customer.phone && <><br /><small className="muted-small">{d.customer.phone}</small></>}</td>
                    <td>{d.riderName || 'Unknown'}</td>
                    <td>{d.address.raw}{!d.address.geocoded && <><br /><small className="muted-small warn">Location not found</small></>}</td>
                    <td><StatusBadge value={d.status} />{d.failure && <><br /><small className="muted-small">{titleCase(d.failure.reason)}</small></>}</td>
                    <td>{dateShort(d.createdAt)}</td>
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
