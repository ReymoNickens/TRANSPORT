import { opsRoute } from "@/lib/api/ops";
import { financeReportCsv, rangeQuery } from "@/server/finance";
import { z } from "zod";

const body = z.intersection(rangeQuery, z.object({ reason: z.string().trim().min(5).max(300) }));

/** The finance report as a spreadsheet. High risk: a reason and a fresh second factor, and audited (18.1). */
export const POST = opsRoute({ permission: "finance.export", body }, ({ tx, body }) => financeReportCsv(tx, body));
