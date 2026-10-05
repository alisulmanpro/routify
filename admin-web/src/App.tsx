import { useState, type ComponentType } from 'react';
import './App.css';
import { AuthProvider, useAuth } from './lib/auth';
import { ToastProvider } from './components/Toast';
import Login from './pages/Login';
import Overview from './pages/Overview';
import Riders from './pages/Riders';
import Deliveries from './pages/Deliveries';
import Reports from './pages/Reports';
import Subscriptions from './pages/Subscriptions';
import Plans from './pages/Plans';
import Payments from './pages/Payments';
import Settings from './pages/Settings';
import AuditLogs from './pages/AuditLogs';

const navItems: [string, string][] = [
  ['▦', 'Overview'], ['♙', 'Riders'], ['▤', 'Deliveries'],
  ['▥', 'Reports'], ['◒', 'Subscriptions'], ['◇', 'Plans'], ['↔', 'Payments'], ['☰', 'Audit log'],
];

const PAGES: Record<string, ComponentType> = {
  Overview, Riders, Deliveries, Reports, Subscriptions, Plans, Payments, Settings, 'Audit log': AuditLogs,
};

function Shell() {
  const { user, logout } = useAuth();
  const [activeNav, setActiveNav] = useState('Overview');
  const Page = PAGES[activeNav] || Overview;
  const initials = user?.fullName.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase() || 'A';

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">dp</span><span>delivery<span className="brand-accent">pilot</span></span></div>
        <nav className="nav-list">
          {navItems.map(([icon, label]) => (
            <button key={label} className={activeNav === label ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav(label)}>
              <span className="nav-item-icon">{icon}</span><span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <button className={activeNav === 'Settings' ? 'nav-item active' : 'nav-item'} onClick={() => setActiveNav('Settings')}><span className="nav-item-icon">⚙</span><span>Settings</span></button>
          <div className="user-chip">
            <span className="user-avatar">{initials}</span>
            <span><strong>{user?.fullName}</strong><small>Platform admin</small></span>
            <button className="more" onClick={logout} title="Sign out">⏻</button>
          </div>
        </div>
      </aside>
      <main className="main-content">
        <Page />
      </main>
    </div>
  );
}

function Gate() {
  const { user, loading } = useAuth();
  if (loading) return <div className="loading-state full-screen">Loading…</div>;
  return user ? <Shell /> : <Login />;
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </ToastProvider>
  );
}
