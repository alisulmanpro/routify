import { useEffect, useState, type FormEvent } from 'react';
import { get, patch, ApiRequestError } from '../lib/api';
import type { Plan } from '../lib/types';
import { money } from '../lib/format';
import Modal from '../components/Modal';
import { useToast } from '../components/Toast';

export default function Plans() {
  const toast = useToast();
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Plan | null>(null);

  const load = () => {
    setLoading(true);
    get<Plan[]>('/admin/plans').then((r) => setPlans(r.data)).catch((e) => toast('error', e.message)).finally(() => setLoading(false));
  };
  useEffect(load, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Plans</h1><p className="heading-copy">Pricing and limits for Free Trial, Starter and Pro.</p></div></div>
      {loading ? <div className="loading-state">Loading…</div> : (
        <div className="module-cards plan-cards">
          {plans.map((p) => (
            <article key={p.key} className="plan-card">
              <div className="plan-card-head"><h2>{p.name}</h2>{!p.active && <span className="status-badge tone-muted">Inactive</span>}</div>
              <div className="plan-price">{money(p.monthlyPrice, p.currency)}<span>/mo</span></div>
              <p className="muted-small">{money(p.annualPrice, p.currency)}/year billed annually</p>
              <ul className="plan-limits">
                <li>{p.limits.deliveriesPerMonth.toLocaleString()} deliveries / month</li>
                <li>{p.limits.reportsPerMonth} reports / month</li>
              </ul>
              <ul className="plan-features">{p.features.map((f) => <li key={f}>✓ {f}</li>)}</ul>
              <p className="muted-small">{p.subscribers} subscriber{p.subscribers === 1 ? '' : 's'}</p>
              <button className="text-button" onClick={() => setEditing(p)}>Edit plan</button>
            </article>
          ))}
        </div>
      )}
      {editing && <EditPlanModal plan={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
    </section>
  );
}

function EditPlanModal({ plan, onClose, onSaved }: { plan: Plan; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: plan.name, monthlyPrice: String(plan.monthlyPrice), annualPrice: String(plan.annualPrice), active: plan.active,
    deliveriesPerMonth: String(plan.limits.deliveriesPerMonth), reportsPerMonth: String(plan.limits.reportsPerMonth),
    features: plan.features.join(', '),
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await patch(`/admin/plans/${plan.key}`, {
        name: form.name, monthlyPrice: Number(form.monthlyPrice), annualPrice: Number(form.annualPrice), active: form.active,
        limits: { deliveriesPerMonth: Number(form.deliveriesPerMonth), reportsPerMonth: Number(form.reportsPerMonth) },
        features: form.features.split(',').map((f) => f.trim()).filter(Boolean),
      });
      toast('success', `${form.name} updated`);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not update plan');
    } finally { setBusy(false); }
  };

  return (
    <Modal title={`Edit ${plan.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={submit}>
        {error && <div className="error-banner">{error}</div>}
        <label className="field-label">Name<input className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
        <label className="field-label">Monthly price<input className="input" type="number" min={0} step="0.01" value={form.monthlyPrice} onChange={(e) => setForm({ ...form, monthlyPrice: e.target.value })} /></label>
        <label className="field-label">Annual price<input className="input" type="number" min={0} step="0.01" value={form.annualPrice} onChange={(e) => setForm({ ...form, annualPrice: e.target.value })} /></label>
        <label className="field-label">Deliveries / month<input className="input" type="number" min={0} value={form.deliveriesPerMonth} onChange={(e) => setForm({ ...form, deliveriesPerMonth: e.target.value })} /></label>
        <label className="field-label">Reports / month<input className="input" type="number" min={0} value={form.reportsPerMonth} onChange={(e) => setForm({ ...form, reportsPerMonth: e.target.value })} /></label>
        <label className="field-label">Features (comma separated)<input className="input" value={form.features} onChange={(e) => setForm({ ...form, features: e.target.value })} /></label>
        <label className="field-checkbox"><input type="checkbox" checked={form.active} disabled={plan.key === 'trial'} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active</label>
        <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save plan'}</button>
      </form>
    </Modal>
  );
}
