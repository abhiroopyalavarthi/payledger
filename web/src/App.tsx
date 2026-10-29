import type { ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './dashboard/Layout';
import { Login } from './dashboard/Login';
import { PayLinks } from './dashboard/PayLinks';
import { PaymentDetail } from './dashboard/PaymentDetail';
import { Payments } from './dashboard/Payments';
import { useAuth } from './lib/auth';
import { PayPage } from './pay/PayPage';

function RequireAuth({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? children : <Navigate to="/login" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/pay/:token" element={<PayPage />} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<Payments />} />
        <Route path="/payments/:id" element={<PaymentDetail />} />
        <Route path="/links" element={<PayLinks />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
