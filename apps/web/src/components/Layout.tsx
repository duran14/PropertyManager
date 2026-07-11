import { type ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';
import { Icon, ICON_COLORS, type IconName } from './Icon';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  roles: string[];
}

const NAV: NavItem[] = [
  { to: '/', label: 'Dashboard', icon: 'dashboard', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/properties', label: 'Properties', icon: 'home', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/photos', label: 'AI Photos', icon: 'sparkles', roles: ['property_manager', 'broker'] },
  { to: '/leads', label: 'Leads', icon: 'leads', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/showings', label: 'Showings', icon: 'showings', roles: ['property_manager', 'broker'] },
  { to: '/conversations', label: 'Conversations', icon: 'chat', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/sentinel', label: 'Financial Sentinel', icon: 'sentinel', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/bills', label: 'Bills / OCR', icon: 'bills', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/leases', label: 'Leases / RTA', icon: 'rta', roles: ['property_manager', 'bookkeeper', 'broker'] },
  { to: '/reconciliation', label: 'Reconciliation', icon: 'reconciliation', roles: ['bookkeeper', 'broker'] },
  { to: '/audit', label: 'Audit Trail', icon: 'audit', roles: ['bookkeeper', 'broker'] },
];

export function Layout({ children }: { children: ReactNode }) {
  const { user, logout } = useAuth();
  if (!user) return null;

  const items = NAV.filter((item) => item.roles.includes(user.role));

  return (
    <div className="min-h-screen flex">
      <aside className="w-64 bg-slate-900 text-slate-300 flex flex-col">
        <div className="p-4 border-b border-slate-700 flex items-center gap-2.5">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-lg bg-brand-600">
            <Icon name="home" size={18} className="text-white" />
          </span>
          <p className="text-xs text-slate-300 leading-tight font-medium">{user.tenantName}</p>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {items.map((item) => {
            const color = ICON_COLORS[item.icon];
            return (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === '/'}
                className={({ isActive }) =>
                  `flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive ? 'bg-slate-800 text-white' : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span
                      className={`inline-flex items-center justify-center w-7 h-7 rounded-md transition-colors ${
                        isActive ? `${color.badge}` : 'bg-transparent'
                      }`}
                    >
                      <Icon
                        name={item.icon}
                        size={17}
                        className={isActive ? color.text : 'text-slate-500'}
                      />
                    </span>
                    {item.label}
                  </>
                )}
              </NavLink>
            );
          })}
        </nav>
        <div className="p-4 border-t border-slate-700">
          <div className="text-xs text-slate-400 mb-2">
            {user.firstName} {user.lastName}
            <span className="block text-slate-500 capitalize">{user.role.replace('_', ' ')}</span>
          </div>
          <button
            onClick={logout}
            className="text-xs text-slate-400 hover:text-white"
          >
            Sign out
          </button>
        </div>
      </aside>

      <main className="flex-1 overflow-auto">
        <div className="p-8 max-w-7xl mx-auto">{children}</div>
      </main>
    </div>
  );
}
