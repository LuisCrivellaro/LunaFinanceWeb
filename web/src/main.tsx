import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "./styles/index.css";
import { ApiError } from "./lib/api";
import { AppProvider, useMe } from "./lib/app";
import { Layout } from "./components/Layout";
import { LoginPage, SetPasswordPage } from "./pages/Auth";
const DashboardPage = lazy(() => import("./pages/Dashboard").then((m) => ({ default: m.DashboardPage })));
const TransactionsPage = lazy(() => import("./pages/Transactions").then((m) => ({ default: m.TransactionsPage })));
const BillsPage = lazy(() => import("./pages/Bills").then((m) => ({ default: m.BillsPage })));
const GoalsPage = lazy(() => import("./pages/Goals").then((m) => ({ default: m.GoalsPage })));
const ReportsPage = lazy(() => import("./pages/Reports").then((m) => ({ default: m.ReportsPage })));
const SettingsPage = lazy(() => import("./pages/Settings").then((m) => ({ default: m.SettingsPage })));
import { Skeleton } from "./components/ui";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (n, e) => !(e instanceof ApiError && [401, 403, 404].includes(e.status)) && n < 2,
      refetchOnWindowFocus: true,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { data, isLoading, error } = useMe();
  const loc = useLocation();
  if (isLoading)
    return (
      <div style={{ padding: 40, display: "grid", gap: 12, maxWidth: 480 }}>
        <Skeleton h={28} w="50%" />
        <Skeleton h={120} />
      </div>
    );
  if (error || !data) return <Navigate to="/entrar" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AppProvider>
        <BrowserRouter>
          <Routes>
            <Route path="/entrar" element={<LoginPage />} />
            <Route path="/definir-senha" element={<SetPasswordPage />} />
            <Route
              element={
                <RequireAuth>
                  <Suspense fallback={<div style={{ padding: 40 }}><Skeleton h={200} /></div>}>
                    <Layout />
                  </Suspense>
                </RequireAuth>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="movimentacoes" element={<TransactionsPage />} />
              <Route path="contas" element={<BillsPage />} />
              <Route path="metas" element={<GoalsPage />} />
              <Route path="relatorios" element={<ReportsPage />} />
              <Route path="configuracoes" element={<SettingsPage />} />
            </Route>
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </BrowserRouter>
      </AppProvider>
    </QueryClientProvider>
  </StrictMode>,
);
