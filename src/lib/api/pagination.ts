import { z } from "zod";

/** Every list is paginated (spec 20.1). */
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PageQuery = z.infer<typeof pageQuery>;

export type Page<T> = { items: T[]; page: number; pageSize: number; total: number };

export function offsetOf(query: PageQuery) {
  return (query.page - 1) * query.pageSize;
}

/** Rows selected with `count(*) over () as total_count` → a page. */
export function pageFrom<T extends { totalCount?: number }>(rows: T[], query: PageQuery): Page<Omit<T, "totalCount">> {
  const total = rows[0]?.totalCount ?? 0;
  return {
    items: rows.map((row) => {
      const { totalCount, ...rest } = row;
      void totalCount;
      return rest;
    }),
    page: query.page,
    pageSize: query.pageSize,
    total: Number(total),
  };
}
