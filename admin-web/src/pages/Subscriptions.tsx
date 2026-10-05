import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, ApiRequestError } from '../lib/api';
import type { Subscription } from '../lib/types';
import { dateShort, money, titleCase } from '../lib/format';
import StatusBadge from '../components/StatusBadge';
import Pagination from '../components/Pagination';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

const STATUSES = ['trialing', 'active', 'past_due', 'expired', 'cancelled'] as const;
const PLANS = ['trial', 'starter', 'pro'] as const;

export default function Subscriptions() {
  const toast = useToast();
  const [rows, setRows] = useState<Subscription[]>([]);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Subscription | null>(null);

  const load = () => {
    setLoading(true);
    get<Subscription[]>('/admin/subscriptions', { page, limit: 20, search: search || undefined, status: status || undefined })
      .then((r) => { setRows(r.data); setPages(r.meta?.pages || 1); })
      .catch((e) => toast('error', e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, [page, status]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Subscriptions</h1><p className="heading-copy">Plan, billing cycle and renewal status for every organization.</p></div></div>

      <form className="filter-row" onSubmit={(e) => { e.preventDefault(); setPage(1); load(); }}>
        <input className="input table-search" placeholder="Search organizations…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="input" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          <option value="">All statuses</option>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}
        </select>
        <button className="text-button" type="submit">Search</button>
      </form>

      <div className="panel module-table">
        {loading ? <div className="loading-state">Loading…</div> : rows.length === 0 ? <div className="module-empty-copy">No subscriptions found.</div> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Rider</th><th>Plan</th><th>Cycle</th><th>Price</th><th>Started</th><th>Renewal</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td><strong>{s.riderName || '—'}</strong></td><td>{titleCase(s.planKey)}</td><td>{titleCase(s.billingCycle)}</td>
                    <td>{money(s.price, s.currency)}</td><td>{dateShort(s.startedAt)}</td><td>{dateShort(s.currentPeriodEnd)}</td>
                    <td><StatusBadge value={s.status} />{s.cancelAtPeriodEnd && <><br /><small className="muted-small warn">Cancels at period end</small></>}</td>
                    <td><button className="text-button" onClick={() => setEditing(s)}>Edit</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Pagination page={page} pages={pages} onChange={setPage} />
      </div>

      {editing && <EditSubscriptionModal subscription={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function EditSubscriptionModal({ subscription, onClose, onSaved }: { subscription: Subscription; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [status, setStatus] = useState(subscription.status);
  const [planKey, setPlanKey] = useState(subscription.planKey);
  const [billingCycle, setBillingCycle] = useState(subscription.billingCycle);
  const [extendDays, setExtendDays] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body: Record<string, unknown> = {};
      if (status !== subscription.status) body.status = status;
      if (planKey !== subscription.planKey) body.planKey = planKey;
      if (billingCycle !== subscription.billingCycle) body.billingCycle = billingCycle;
      if (extendDays) body.extendDays = Number(extendDays);
      if (Object.keys(body).length === 0) { onClose(); return; }
      await patch(`/admin/subscriptions/${subscription.id}`, body);
      toast('success', 'Subscription updated');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update subscription');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Edit subscription — ${subscription.riderName}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="error-banner">{error}</div>}
        <label className="field-label">Plan
          <select className="input" value={planKey} onChange={(e) => setPlanKey(e.target.value as typeof planKey)}>{PLANS.map((p) => <option key={p} value={p}>{titleCase(p)}</option>)}</select>
        </label>
        <label className="field-label">Billing cycle
          <select className="input" value={billingCycle} onChange={(e) => setBillingCycle(e.target.value as typeof billingCycle)}><option value="monthly">Monthly</option><option value="annual">Annual</option></select>
        </label>
        <label className="field-label">Status
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>{STATUSES.map((s) => <option key={s} value={s}>{titleCase(s)}</option>)}</select>
        </label>
        <label className="field-label">Extend period by (days, optional)
          <input className="input" type="number" min={1} value={extendDays} onChange={(e) => setExtendDays(e.target.value)} placeholder="e.g. 30" />
        </label>
        <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save changes'}</button>
      </form>
    </Modal>
  );
}
