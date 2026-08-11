/** App router + auth context. */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, type Business, type MeResponse, type User } from "./api";
import { Spinner } from "./components/ui";
import { Landing } from "./pages/Landing";
import { Login, Signup } from "./pages/Auth";
import { AppShell } from "./pages/AppShell";
import { Dashboard } from "./pages/Dashboard";
import { Onboarding } from "./pages/Onboarding";
import { Placeholder } from "./pages/Placeholder";
import { AiAgents } from "./pages/AiAgents";
import { Analytics } from "./pages/Analytics";
import { Leads } from "./pages/Leads";
import { LeadDetail } from "./pages/LeadDetail";
import { KnowledgeBase } from "./pages/KnowledgeBase";
import { Conversations } from "./pages/Conversations";
import { ConversationDetail } from "./pages/ConversationDetail";
import { Appointments } from "./pages/Appointments";
import { FollowUps } from "./pages/FollowUps";
import { Integrations } from "./pages/Integrations";
import { WidgetDemo } from "./pages/WidgetDemo";
import { ContactPage, FeaturesPage, PricingPage, PrivacyPage, TermsPage } from "./pages/Marketing";

interface AuthState {
  user: User | null;
  business: Business | null;
  loading: boolean;
  refresh: () => Promise<MeResponse>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  user: null,
  business: null,
  loading: true,
  refresh: async () => ({ user: null as never, business: null, subscription: null }),
  logout: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [business, setBusiness] = useState<Business | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = async (): Promise<MeResponse> => {
    const res = await api<MeResponse>("/api/auth/me");
    setUser(res.user);
    setBusiness(res.business);
    setLoading(false);
    return res;
  };

  const logout = async () => {
    try {
      await api("/api/auth/logout", { method: "POST" });
    } finally {
      setUser(null);
      setBusiness(null);
      setLoading(false);
    }
  };

  useEffect(() => {
    api<MeResponse>("/api/auth/me")
      .then((r) => {
        setUser(r.user);
        setBusiness(r.business);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  const value = useMemo(() => ({ user, business, loading, refresh, logout }), [user, business, loading, refresh, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <Spinner label="Checking your session…" />;
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}

function OnboardingGate() {
  // Inside /app: users without a business (or with onboarding incomplete) are
  // sent to the wizard; everyone else sees the app shell.
  const { business } = useAuth();
  const location = useLocation();
  const needsOnboarding = !business || !business.onboardingCompleted;
  if (needsOnboarding && location.pathname !== "/app/onboarding") {
    return <Navigate to="/app/onboarding" replace />;
  }
  if (!needsOnboarding && location.pathname === "/app/onboarding") {
    return <Navigate to="/app/dashboard" replace />;
  }
  return <AppShell />;
}

/** Scroll to top on route change (hash anchors like #demo are plain <a href>,
 * so they don't trigger this — native browser behavior handles them). */
function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [pathname]);
  return null;
}

export function App() {
  return (
    <AuthProvider>
      <ScrollToTop />
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route path="/features" element={<FeaturesPage />} />
        <Route path="/contact" element={<ContactPage />} />
        <Route path="/terms" element={<TermsPage />} />
        <Route path="/privacy" element={<PrivacyPage />} />
        <Route path="/widget-demo" element={<WidgetDemo />} />
        <Route path="/login" element={<Login />} />
        <Route path="/signup" element={<Signup />} />
        <Route
          path="/app"
          element={
            <RequireAuth>
              <OnboardingGate />
            </RequireAuth>
          }
        >
          <Route path="onboarding" element={<Onboarding />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="leads" element={<Leads />} />
          <Route path="leads/:id" element={<LeadDetail />} />
          <Route path="conversations" element={<Conversations />} />
          <Route path="conversations/:id" element={<ConversationDetail />} />
          <Route path="appointments" element={<Appointments />} />
          <Route path="follow-ups" element={<FollowUps />} />
          <Route path="agents" element={<AiAgents />} />
          <Route path="knowledge" element={<KnowledgeBase />} />
          <Route path="analytics" element={<Analytics />} />
          <Route path="integrations" element={<Integrations />} />
          <Route path="settings" element={<Placeholder title="Settings" description="Business profile, team members, and AI agent configuration." />} />
          <Route path="billing" element={<Placeholder title="Billing" description="Plan, invoices, and payment method." />} />
          <Route index element={<Navigate to="dashboard" replace />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
