/** Login & Signup pages. */
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type MeResponse } from "../api";
import { Button, Card, Field, Input } from "../components/ui";
import { useAuth } from "../App";

function AuthLayout({ children, footer }: { children: React.ReactNode; footer: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-gradient-to-b from-indigo-50 via-slate-50 to-slate-50 px-4">
      <Link to="/" className="mb-8 flex items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-indigo-600">
          <svg viewBox="0 0 24 24" className="h-5 w-5 text-white" fill="currentColor">
            <path d="M4 4h16v5h-2V6H6v12h6v2H4z" />
            <path d="M14 9h6v2h-4v1h3v2h-3v1h4v2h-6z" opacity=".85" />
          </svg>
        </span>
        <span className="text-lg font-bold tracking-tight text-slate-900">
          LeadFlow<span className="text-indigo-600"> AI</span>
        </span>
      </Link>
      <Card className="w-full max-w-md p-8">{children}</Card>
      <p className="mt-6 text-sm text-slate-500">{footer}</p>
    </div>
  );
}

export function Login() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  // ?demo=1 (from the landing page / widget demo) prefills the seeded demo
  // account so prospects can explore the owner dashboard in one click.
  const demo = new URLSearchParams(window.location.search).get("demo") === "1";
  const [email, setEmail] = useState(demo ? "demo@leadflow.ai" : "");
  const [password, setPassword] = useState(demo ? "demo1234" : "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<MeResponse>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
      await refresh();
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout footer={<>New to LeadFlow? <Link to="/signup" className="font-semibold text-indigo-600 hover:text-indigo-500">Create an account</Link></>}>
      <h1 className="text-xl font-bold text-slate-900">Welcome back</h1>
      <p className="mt-1 text-sm text-slate-500">Log in to your business dashboard.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
        </Field>
        <Field label="Password">
          <Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Logging in…" : "Log in"}
        </Button>
      </form>
      <div className="mt-6 rounded-lg bg-slate-50 p-3 text-xs text-slate-500">
        <p className="font-semibold text-slate-600">Demo account</p>
        <p>
          demo@leadflow.ai / demo1234 — a fully set-up example business (Smith's HVAC) with sample data.
        </p>
      </div>
    </AuthLayout>
  );
}

export function Signup() {
  const navigate = useNavigate();
  const { refresh } = useAuth();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api<MeResponse>("/api/auth/signup", { method: "POST", body: JSON.stringify({ name, email, password }) });
      await refresh();
      navigate("/app");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Signup failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout footer={<>Already have an account? <Link to="/login" className="font-semibold text-indigo-600 hover:text-indigo-500">Log in</Link></>}>
      <h1 className="text-xl font-bold text-slate-900">Create your account</h1>
      <p className="mt-1 text-sm text-slate-500">Start your 14-day free trial. No credit card required.</p>
      <form onSubmit={submit} className="mt-6 space-y-4">
        <Field label="Your name">
          <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Smith" />
        </Field>
        <Field label="Email">
          <Input type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@business.com" />
        </Field>
        <Field label="Password" hint="At least 8 characters.">
          <Input type="password" required minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" />
        </Field>
        {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p> : null}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthLayout>
  );
}
