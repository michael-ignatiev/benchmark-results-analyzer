export interface PgQueryResult<Row> {
  rows: Row[];
}

export interface PgQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
}

export interface PgClientLike extends PgQueryable {
  release?: () => void;
}

export interface PgPoolLike extends PgQueryable {
  connect?: () => Promise<PgClientLike>;
}
