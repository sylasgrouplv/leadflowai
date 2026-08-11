/** Generic placeholder for modules that arrive in the next build. */
import { PageHeader } from "../components/ui";

export function Placeholder({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <PageHeader title={title} subtitle={description} />
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white/60 px-6 py-20 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-full bg-indigo-50">
          <svg className="h-6 w-6 text-indigo-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z" />
          </svg>
        </span>
        <h3 className="mt-4 text-base font-semibold text-slate-800">Coming in the next build</h3>
        <p className="mt-2 max-w-md text-sm text-slate-500">
          The {title.toLowerCase()} module is wired into the app shell and its data model is ready — the screens land in a
          follow-up build.
        </p>
        <span className="mt-6 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-600">Foundation build · phase 1</span>
      </div>
    </div>
  );
}
