import { useEffect, useState } from 'react';
import { get } from '../lib/api';
import type { Overview as OverviewType } from '../lib/types';
import { money, dateShort } from '../lib/format';
import StatusBadge from '../components/StatusBadge';

export default function Overview() {
  const [data, setData] = useState<OverviewType | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    get<OverviewType>('/admin/overview').then((r) => setData(r.data)).catch((e) => setError(e.message));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="loading-state">Loading network overview…</div>;

  const maxVolume = Math.max(1, ...data.volume.map((v) => v.total));
  const delivered = data.volume.reduce((n, v) => n + v.delivered, 0);
  const failed = data.volume.reduce((n, v) => n + v.failed, 0);
  const finished = delivered + failed;
  const deliveredPct = finished ? Math.round((delivered / finished) * 100) : 0;

  return (
    <>
      <section className="page-heading">
        <div><p className="eyebrow">Platform overview</p><h1>Good morning, Admin</h1><p className="heading-copy">Here is what is happening across your delivery network today.</p></div>
      </section>

      <section className="metric-grid">
        <Metric title="Riders" value={data.metrics.riders.toLocaleString()} change={`${data.metrics.ridersChangePct >= 0 ? '+' : ''}${data.metrics.ridersChangePct}% this week`} icon="♙" tone="blue" />
        <Metric title="Active riders (24h)" value={`${data.metrics.activeRiders24h} / ${data.metrics.riders}`} change={`${data.metrics.activeRoutes} routes live`} icon="⚡" tone="green" />
        <Metric title="Deliveries today" value={data.metrics.deliveriesToday.toLocaleString()} change={`${data.metrics.deliveriesChangePct >= 0 ? '+' : ''}${data.metrics.deliveriesChangePct}% vs last week`} icon="▤" tone="amber" />
        <Metric title="Subscription revenue" value={data.metrics.subscriptionRevenueMonth.map((c) => money(c.amount, c.currency)).join(', ') || money(0)} change="This month" icon="◈" tone="violet" />
      </section>

      <section className="dashboard-grid">
        <article className="panel volume-panel">
          <div className="panel-heading"><div><h2>Delivery volume</h2><p>Completed vs failed, last {data.volume.length} days</p></div></div>
          <div className="chart"><div className="chart-body"><div className="bars">
            {data.volume.map((v) => <div key={v.date} className="bar-column" title={`${v.date}: ${v.total} total`}><span style={{ height: `${(v.total / maxVolume) * 100}%` }} /><small>{v.date.slice(5)}</small></div>)}
          </div></div></div>
        </article>
        <article className="panel payment-panel">
          <div className="panel-heading"><div><h2>Delivery outcomes</h2><p>Delivered vs failed, last {data.volume.length} days</p></div></div>
          <div className="donut-wrap">
            <div className="donut" style={{ background: finished ? `conic-gradient(#277ce0 0 ${deliveredPct}%, #f0b74d ${deliveredPct}% 100%)` : '#e5e9f0' }}>
              <div className="donut-hole"><strong>{finished.toLocaleString()}</strong><span>finished</span></div>
            </div>
            <div className="legend">
              <span><i className="legend-dot prepaid" />Delivered <b>{deliveredPct}%</b></span>
              <span><i className="legend-dot cod" />Failed <b>{finished ? 100 - deliveredPct : 0}%</b></span>
            </div>
          </div>
        </article>
      </section>

      <section className="dashboard-grid lower-grid">
        <article className="panel routes-panel">
          <div className="panel-heading"><div><h2>Live route activity</h2><p>Riders currently on the road</p></div></div>
          <div className="route-list">
            {data.liveRoutes.length === 0 && <p className="module-empty-copy">No routes are active right now.</p>}
            {data.liveRoutes.map((r) => (
              <div key={r.id} className="route-row">
                <span className="route-avatar blue">{r.rider.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
                <div className="route-info"><strong>{r.rider}</strong></div>
                <div className="route-progress">
                  <div><span>{r.done} of {r.total} done</span><b>{r.total ? Math.round((r.done / r.total) * 100) : 0}%</b></div>
                  <i><em className="blue" style={{ width: `${r.total ? (r.done / r.total) * 100 : 0}%` }} /></i>
                </div>
              </div>
            ))}
          </div>
        </article>
        <article className="panel subscription-panel">
          <div className="panel-heading"><div><h2>Subscription health</h2><p>Current account status</p></div></div>
          <div className="subscription-total"><strong>{data.subscriptions.total}</strong><span>riders</span></div>
          <div className="subscription-bars">
            <span><i className="bar starter" style={{ width: '100%' }} />Trial <b>{data.subscriptions.byPlan.trial || 0}</b></span>
            <span><i className="bar pro" style={{ width: '100%' }} />Starter <b>{data.subscriptions.byPlan.starter || 0}</b></span>
            <span><i className="bar trial" style={{ width: '100%' }} />Pro <b>{data.subscriptions.byPlan.pro || 0}</b></span>
          </div>
        </article>
      </section>

      <section className="panel deliveries-panel">
        <div className="panel-heading"><div><h2>Recent deliveries</h2><p>Latest delivery activity across your network</p></div></div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Parcel ID</th><th>Customer</th><th>Rider</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {data.recentDeliveries.map((d) => (
                <tr key={d.id}>
                  <td><strong>{d.trackingId}</strong></td><td>{d.customer.name || '—'}</td><td>{d.riderName || 'Unknown'}</td>
                  <td><StatusBadge value={d.status} /></td><td>{dateShort(d.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function Metric({ title, value, change, icon, tone }: { title: string; value: string; change: string; icon: string; tone: string }) {
  return <article className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div><p>{title}</p><strong>{value}</strong><span className="metric-change">{change}</span></div></article>;
}
