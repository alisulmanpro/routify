import { useEffect, useState, type FormEvent } from 'react';
import { get, put, ApiRequestError } from '../lib/api';
import type { Settings as SettingsType, Currency } from '../lib/types';
import { useToast } from '../components/Toast';

const ALL_CURRENCIES: Currency[] = ['USD', 'GBP', 'EUR', 'PKR', 'INR'];

export default function Settings() {
  const toast = useToast();
  const [settings, setSettings] = useState<SettingsType | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { get<SettingsType>('/admin/settings').then((r) => setSettings(r.data)).catch((e) => toast('error', e.message)); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!settings) return <div className="loading-state">Loading settings…</div>;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const saved = await put<SettingsType>('/admin/settings', settings);
      setSettings(saved.data);
      toast('success', 'Settings saved');
    } catch (err) {
      setError(err instanceof ApiRequestError ? err.message : 'Could not save settings');
    } finally { setBusy(false); }
  };

  return (
    <section className="module-view">
      <div className="module-heading"><div><p className="eyebrow">Admin workspace</p><h1>Platform settings</h1><p className="heading-copy">Configuration that applies across every organization.</p></div></div>
      <form className="panel settings-form" onSubmit={submit}>
        {error && <div className="error-banner">{error}</div>}

        <h3>Platform</h3>
        <div className="form-grid">
          <label className="field-label">Platform name<input className="input" value={settings.platform.name} onChange={(e) => setSettings({ ...settings, platform: { ...settings.platform, name: e.target.value } })} /></label>
          <label className="field-label">Support email<input className="input" type="email" value={settings.platform.supportEmail} onChange={(e) => setSettings({ ...settings, platform: { ...settings.platform, supportEmail: e.target.value } })} /></label>
          <label className="field-label">Privacy policy URL<input className="input" value={settings.platform.privacyUrl} onChange={(e) => setSettings({ ...settings, platform: { ...settings.platform, privacyUrl: e.target.value } })} /></label>
          <label className="field-label full-width">Payment instructions (shown to riders upgrading)<textarea className="input" rows={3} value={settings.platform.paymentInstructions} onChange={(e) => setSettings({ ...settings, platform: { ...settings.platform, paymentInstructions: e.target.value } })} /></label>
        </div>

        {/* Riders no longer pick a currency; this one is used for plan prices and new accounts. */}
        <h3>Currency</h3>
        <label className="field-label">Default currency
          <select className="input" value={settings.defaultCurrency} onChange={(e) => setSettings({ ...settings, defaultCurrency: e.target.value as Currency })}>
            {ALL_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>

        <h3>Trial &amp; routing</h3>
        <div className="form-grid">
          <label className="field-label">Free trial (through Google Play / App Store)
            <select className="input" value={settings.trialDays} onChange={(e) => setSettings({ ...settings, trialDays: Number(e.target.value) })}>
              <option value={1}>1 day (test stores only)</option><option value={3}>3 days</option>
              <option value={7}>7 days</option><option value={14}>14 days</option><option value={30}>30 days</option>
            </select>
            <small className="muted-small">Riders add a payment method in the store to start it. Keep Play Console offers (free-trial-3d / 7d / 14d / 30d) and the App Store introductory offer matching. Google Play and the App Store need at least 3 days.</small>
          </label>
          <label className="field-label">Default route preference
            <select className="input" value={settings.route.defaultPreference} onChange={(e) => setSettings({ ...settings, route: { ...settings.route, defaultPreference: e.target.value } })}>
              <option value="smart">Smart</option><option value="nearest_first">Nearest first</option><option value="shortest">Shortest</option>
            </select>
          </label>
          <label className="field-label">Average speed (km/h)<input className="input" type="number" min={5} value={settings.route.avgSpeedKmh} onChange={(e) => setSettings({ ...settings, route: { ...settings.route, avgSpeedKmh: Number(e.target.value) } })} /></label>
          <label className="field-label">Service time per stop (min)<input className="input" type="number" min={0} value={settings.route.stopServiceMinutes} onChange={(e) => setSettings({ ...settings, route: { ...settings.route, stopServiceMinutes: Number(e.target.value) } })} /></label>
          <label className="field-checkbox"><input type="checkbox" checked={settings.reports.includePhotos} onChange={(e) => setSettings({ ...settings, reports: { includePhotos: e.target.checked } })} /> Include proof photos in PDF reports</label>
        </div>

        <h3>Security</h3>
        <div className="form-grid">
          <label className="field-label">Minimum password length<input className="input" type="number" min={6} value={settings.security.minPasswordLength} onChange={(e) => setSettings({ ...settings, security: { ...settings.security, minPasswordLength: Number(e.target.value) } })} /></label>
          <label className="field-label">Max failed logins before lockout<input className="input" type="number" min={3} value={settings.security.maxFailedLogins} onChange={(e) => setSettings({ ...settings, security: { ...settings.security, maxFailedLogins: Number(e.target.value) } })} /></label>
          <label className="field-label">Lockout duration (minutes)<input className="input" type="number" min={1} value={settings.security.lockoutMinutes} onChange={(e) => setSettings({ ...settings, security: { ...settings.security, lockoutMinutes: Number(e.target.value) } })} /></label>
        </div>

        <button className="primary-action" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save settings'}</button>
      </form>
    </section>
  );
}
