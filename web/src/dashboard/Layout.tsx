import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../lib/auth';

export function Layout() {
  const { session, signOut } = useAuth();
  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="logo">P</span> PayLedger
        </div>
        <nav>
          <NavLink to="/" end>
            Payments
          </NavLink>
          <NavLink to="/links">Pay links</NavLink>
        </nav>
        <div className="who">
          <span>{session?.merchantName}</span>
          <button className="link-button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
