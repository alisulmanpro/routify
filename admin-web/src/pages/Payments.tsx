import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, post, ApiRequestError } from '../lib/api';
import type { Payment, Rider, Currency } from '../lib/types';
import { dateShort, money, titleCase } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

export default function Payments() {
  const toast = useToast();
  const [rows, setRows] = useState<Payment[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    get<Payment[]>('/admin/payments', { page, limit: 20, search: search || undefined, status: status || undefined })
      .then((r) => { setRows(r.data); setPages(r.meta?.pages || 1); })
      .catch((e) => toast('error', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page, status]); // eslint-disable-line react-hooks/exhaustive-deps

  const setPaymentStatus = async (payment: Payment, next: 'succeeded' | 'failed' | 'refunded') => {
    setBusyId(payment.id);
    try {
      await patch(`/admin/payments/${payment.id}`, { status: next });
      toast('success', `Payment marked ${next}`);
      load();
    } catch (e) {
      toast('error', e instanceof ApiRequestError ? e.message : 'Update failed');
    } finally { setBusyId(null); }
  };

  return (
    <section className="module-view">
      <div className="module-heading">
        <div><p className="eyebrow">Admin workspace</p><h1>Payments</h1><p className="heading-copy">Subscription payments billed directly to riders — customer COD money is never mixed in here.</p></div>
        <button className="primary-action" onClick={() => setShowCreate(true)}>+ Record payment</button>
      </div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <input className="input table-search" placeholder="Search rider…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option><option value="pending">Pending</option><option value="succeeded">Succeeded</option><option value="failed">Failed</option><option value="refunded">Refunded</option>
        </select>
        <button className="text-button" type="submit">Search</button>
      </form>

      <div className="panel module-table">
        {loading ? <div className="loading-state">Loading…</div> : rows.length === 0 ? <div className="module-empty-copy">No payments recorded yet.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Rider</th><th>Plan</th><th>Amount</th><th>Status</th><th>Paid at</th><th>Created</th><th></th></tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td>{p.riderName || '—'}</td>
                    <td>{titleCase(p.planKey)} ({titleCase(p.billingCycle)})</td>
                    <td>{money(p.amount, p.currency)}</td><td><StatusBadge value={p.status} /></td>
                    <td>{dateShort(p.paidAt)}</td><td>{dateShort(p.createdAt)}</td>
                    <td>
                      {p.status === 'pending' && (
                        <>
                          <button className="text-button" disabled={busyId === p.id} onClick={() => setPaymentStatus(p, 'succeeded')}>Mark succeeded</button>{' '}
                          <button className="text-button" disabled={busyId === p.id} onClick={() => setPaymentStatus(p, 'failed')}>Mark failed</button>
                        </>
                      )}
                      {p.status === 'succeeded' && <button className="text-button" disabled={busyId === p.id} onClick={() => setPaymentStatus(p, 'refunded')}>Refund</button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} onChange={setPage} />
      </div>

      {showCreate && <RecordPaymentModal onClose={() => setShowCreate(false)} onCreated={() => { setShowCreate(false); load(); }} />}
    </section>
  );
}

function RecordPaymentModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [query, setQuery] = useState('');
  const [riderResults, setRiderResults] = useState<Rider[]>([]);
  const [riderId, setRiderId] = useState('');
  const [planKey, setPlanKey] = useState<'starter' | 'pro'>('starter');
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'annual'>('monthly');
  const [amount, setAmount] = useState('');
  const [currency, setCurrency] = useState<Currency>('USD');
  const [status, setStatus] = useState<'pending' | 'succeeded'>('succeeded');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (query.length < 2) { setRiderResults([]); return; }
    const t = setTimeout(() => { get<Rider[]>('/admin/riders', { search: query, limit: 8 }).then((r) => setRiderResults(r.data)).catch(() => {}); }, 250);
    return () => clearTimeout(t);
  }, [query]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!riderId) { setError('Choose a rider from the list'); return; }
    setBusy(true);
    setError('');
    try {
      await post('/admin/payments', { riderId, planKey, billingCycle, amount: amount ? Number(amount) : undefined, currency, status });
      toast('success', 'Payment recorded');
      onCreated();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not record payment');
    } finally { setBusy(false); }
  };

  return (
    <Modal title="Record a manual payment" onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="error-banner">{error}</div>}
        <label className="field-label full-width">Rider
          <input className="input" placeholder="Search by name or email…" value={query} onChange={(e) => { setQuery(e.target.value); setRiderId(''); }} />
        </label>
        {riderResults.length > 0 && !riderId && (
          <div className="org-suggest full-width">
            {riderResults.map((r) => <button type="button" key={r.id} className="org-suggest-row" onClick={() => { setRiderId(r.id); setQuery(`${r.fullName} (${r.email})`); setRiderResults([]); }}>{r.fullName} — {r.email}</button>)}
          </div>
        )}
        <label className="field-label">Plan<select className="input" value={planKey} onChange={(e) => setPlanKey(e.target.value as typeof planKey)}><option value="starter">Starter</option><option value="pro">Pro</option></select></label>
        <label className="field-label">Billing cycle<select className="input" value={billingCycle} onChange={(e) => setBillingCycle(e.target.value as typeof billingCycle)}><option value="monthly">Monthly</option><option value="annual">Annual</option></select></label>
        <label className="field-label">Amount (optional — defaults to plan price)<input className="input" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="field-label">Currency<select className="input" value={currency} onChange={(e) => setCurrency(e.target.value as Currency)}>{(['USD', 'GBP', 'EUR', 'PKR', 'INR'] as Currency[]).map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
        <label className="field-label">Status<select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}><option value="succeeded">Succeeded (activate now)</option><option value="pending">Pending</option></select></label>
        <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Recording…' : 'Record payment'}</button>
      </form>
    </Modal>
  );
}
