import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createFareTable, createFareTableInput, listFareTables, listFareTablesQuery } from "@/server/fares";

export const GET = opsRoute({ permission: "fare.manage", query: pageQuery.extend(listFareTablesQuery.shape) }, ({ tx, query }) =>
  listFareTables(tx, query),
);

export const POST = opsRoute({ permission: "fare.manage", body: createFareTableInput, status: 201 }, ({ tx, actor, body }) =>
  createFareTable(tx, actor.userId, body),
);
