import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createFee, createFeeInput, listFees } from "@/server/fares";

export const GET = opsRoute({ permission: "fare.manage", query: pageQuery }, ({ tx, query }) => listFees(tx, query));

export const POST = opsRoute({ permission: "fare.manage", body: createFeeInput, status: 201 }, ({ tx, actor, body }) =>
  createFee(tx, actor.userId, body),
);
