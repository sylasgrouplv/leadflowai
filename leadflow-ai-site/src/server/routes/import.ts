/**
 * CSV PROSPECT IMPORT route (dogfooding Phase 1a — Chunk B).
 *
 * POST /api/import/prospects — upload a campaign CSV (multipart field `file`
 * or a raw text/csv body) and create one lead per row with
 * source='prospect_import', status='new', score='cold' (scoreValue 0).
 *
 *   - Tenant-scoped: resolves the business exactly like routes/leads.ts
 *     (resolveBusiness + requireUser). Any authenticated user of the business
 *     may import — owner or admin (employees cannot create leads, mirroring
 *     POST /api/leads which is owner-only; import is a bulk create so the
 *     same role line applies: owner + admin yes, employee no).
 *   - Per-row results are returned (created / skipped + reason) — import is
 *     partial-success, never all-or-nothing.
 *   - Every created lead emits LEAD_CREATED (the same event the create_lead
 *     tool emits), so tenant automation rules behave identically.
 *
 * Import is an API route, not an AI tool — it intentionally does NOT touch
 * the tool registry. All mutations go through repo.createLead; all events
 * through emitEvent.
 */
import { Hono } from "hono";
import { attachUser, HttpError, requireUser, resolveBusiness } from "../auth/guards";
import { importProspectCsv } from "../import/prospects";
import * as repo from "../db/repo";

export const importRoutes = new Hono();
importRoutes.use("*", attachUser);

const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5 MB — generous for campaign lists

importRoutes.post("/prospects", async (c) => {
  const business = await resolveBusiness(c);
  const user = await requireUser(c);
  // Employees manage assigned leads + status/notes only (spec) — bulk import
  // is an owner/admin capability, same role line as POST /api/leads.
  if (user.role !== "owner" && user.role !== "admin") {
    throw new HttpError(403, "Only owners and admins can import prospects.");
  }

  const contentType = c.req.header("content-type") ?? "";
  let csvText = "";

  if (contentType.includes("multipart/form-data")) {
    const form = await c.req.parseBody().catch(() => null);
    if (!form) throw new HttpError(400, "Invalid multipart body.");
    const file = form["file"];
    if (!(file instanceof File) && !(typeof file === "object" && file !== null && typeof (file as { text?: unknown }).text === "function")) {
      throw new HttpError(400, "Expected a multipart file field named `file`.");
    }
    csvText = await (file as File).text();
  } else if (contentType.includes("text/csv") || contentType.includes("application/csv")) {
    csvText = await c.req.text();
  } else {
    // Also accept a raw CSV body (curl -d @file.csv) for scripting.
    const raw = await c.req.text().catch(() => "");
    if (raw.trim().startsWith("business_name") || raw.trim() === "") {
      csvText = raw;
    } else {
      throw new HttpError(400, "Send a multipart form with a `file` field, or a text/csv body.");
    }
  }

  if (csvText.length > MAX_CSV_BYTES) throw new HttpError(413, "CSV too large (max 5 MB).");

  const result = await importProspectCsv(business.id, csvText);
  return c.json(
    {
      businessId: business.id,
      source: "prospect_import",
      total: result.total,
      created: result.created,
      skipped: result.skipped,
      rows: result.rows,
    },
    result.created > 0 ? 201 : 200,
  );
});

/** GET /api/import/prospects — summary counts for campaign views. */
importRoutes.get("/prospects", async (c) => {
  const business = await resolveBusiness(c);
  await requireUser(c);
  const rows = await repo.listLeadsBySource(business.id, "prospect_import");
  return c.json({
    businessId: business.id,
    source: "prospect_import",
    count: rows.length,
    leads: rows,
  });
});
