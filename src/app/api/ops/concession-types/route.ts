import { opsRoute } from "@/lib/api/ops";
import { pageQuery } from "@/lib/api/pagination";
import { createConcession, createConcessionInput, listConcessions } from "@/server/fares";

export const GET = opsRoute({ permission: "fare.manage", query: pageQuery }, ({ tx, query }) => listConcessions(tx, query));

export const POST = opsRoute({ permission: "fare.manage", body: createConcessionInput, status: 201 }, ({ tx, actor, body }) =>
  createConcession(tx, actor.userId, body),
);
