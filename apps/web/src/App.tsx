import { Navigate, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { BillsPage } from './pages/BillsPage';
import { ReconciliationPage } from './pages/ReconciliationPage';
import { AuditPage } from './pages/AuditPage';
import { LeadsPage } from './pages/LeadsPage';
import { LeadDetailPage } from './pages/LeadDetailPage';
import { SentinelPage } from './pages/SentinelPage';
import { LeasesPage } from './pages/LeasesPage';
import { PhotosPage } from './pages/PhotosPage';
import { ConversationsPage } from './pages/ConversationsPage';
import { ShowingsPage } from './pages/ShowingsPage';
import { PropertiesPage } from './pages/PropertiesPage';
import { useQuery } from '@tanstack/react-query';
import { apiFetch } from './lib/apiClient';
import type { Lease } from './lib/types';

interface Unit {
  id: string;
  name: string;
  property: { name: string; city: string };
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

/** Wrapper que carga los leases para pasarlos a LeasesPage. */
function LeasesRoute() {
  const { data } = useQuery<{ leases: Lease[] }>({
    queryKey: ['leases'],
    queryFn: () => apiFetch('/leases'),
  });
  return <LeasesPage leases={data?.leases ?? []} />;
}

/** Wrapper that loads units before rendering PhotosPage. */
function PhotosRoute() {
  const { data } = useQuery<{ units: Unit[] }>({
    queryKey: ['units'],
    queryFn: () => apiFetch('/units'),
  });
  return <PhotosPage units={data?.units ?? []} />;
}

function ProtectedRoutes() {
  const { user } = useAuth();
  if (!user) return <Navigate to="/login" replace />;
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/properties" element={<PropertiesPage />} />
        <Route path="/photos" element={<PhotosRoute />} />
        <Route path="/leads" element={<LeadsPage />} />
        <Route path="/leads/:id" element={<LeadDetailPage />} />
        <Route path="/showings" element={<ShowingsPage />} />
        <Route path="/conversations" element={<ConversationsPage />} />
        <Route path="/sentinel" element={<SentinelPage />} />
        <Route path="/bills" element={<BillsPage />} />
        <Route path="/leases" element={<LeasesRoute />} />
        <Route path="/reconciliation" element={<ReconciliationPage />} />
        <Route path="/audit" element={<AuditPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </AuthProvider>
    </QueryClientProvider>
  );
}
