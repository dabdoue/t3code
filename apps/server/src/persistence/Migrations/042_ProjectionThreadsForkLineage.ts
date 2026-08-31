import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;

  if (!columns.some((column) => column.name === "forked_from_thread_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN forked_from_thread_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "fork_point_message_id")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_point_message_id TEXT
    `;
  }
  if (!columns.some((column) => column.name === "fork_kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN fork_kind TEXT
    `;
  }
});
