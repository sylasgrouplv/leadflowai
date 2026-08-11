/**
 * NotificationsBell — in-app notifications (appointment booked, follow-up
 * sent, escalation, …). Polls /api/notifications, shows an unread badge, and
 * drops down the latest notifications with mark-read / mark-all-read.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, fmtDateTime, type Notification } from "../api";
import { cx } from "./ui";

export function NotificationsBell() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    api<{ notifications: Notification[]; unread: number }>("/api/notifications?limit=15")
      .then((r) => {
        setNotifications(r.notifications);
        setUnread(r.unread);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const markRead = async (id: string) => {
    await api(`/api/notifications/${id}/read`, { method: "POST" });
    load();
  };
  const markAll = async () => {
    await api("/api/notifications/read-all", { method: "POST" });
    load();
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        aria-label="Notifications"
      >
        <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75v-.7V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0"
          />
        </svg>
        {unread > 0 ? (
          <span className="absolute -right-0.5 -top-0.5 flex h-4.5 min-w-4.5 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="absolute right-0 z-40 mt-2 w-96 max-w-[90vw] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <p className="text-sm font-bold text-slate-800">Notifications</p>
            {unread > 0 ? (
              <button onClick={markAll} className="text-xs font-semibold text-indigo-600 hover:text-indigo-500">
                Mark all read
              </button>
            ) : null}
          </div>
          <div className="scroll-thin max-h-96 overflow-y-auto">
            {notifications.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-slate-400">Nothing yet — booking and follow-up events will appear here.</p>
            ) : (
              notifications.map((n) => (
                <button
                  key={n.id}
                  onClick={() => !n.read && markRead(n.id)}
                  className={cx("block w-full border-b border-slate-50 px-4 py-3 text-left hover:bg-slate-50", !n.read && "bg-indigo-50/40")}
                >
                  <div className="flex items-start gap-2">
                    <span
                      className={cx(
                        "mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide",
                        n.kind === "appointment" ? "bg-violet-100 text-violet-700" : n.kind === "followup" ? "bg-emerald-100 text-emerald-700" : n.kind === "escalation" ? "bg-red-100 text-red-700" : "bg-slate-100 text-slate-600"
                      )}
                    >
                      {n.kind}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold leading-snug text-slate-800">{n.title}</p>
                      {n.body ? <p className="mt-0.5 truncate text-xs text-slate-500">{n.body}</p> : null}
                      <p className="mt-0.5 text-[11px] text-slate-400">{fmtDateTime(n.createdAt)}</p>
                    </div>
                    {!n.read ? <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-indigo-500" /> : null}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
