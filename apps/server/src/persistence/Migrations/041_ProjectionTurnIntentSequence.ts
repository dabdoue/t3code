import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_turns)
  `;
  if (!columns.some((column) => column.name === "intent_event_sequence")) {
    yield* sql`
      ALTER TABLE projection_turns
      ADD COLUMN intent_event_sequence INTEGER
    `;
  }

  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_turns_intent_event_sequence
    ON projection_turns(intent_event_sequence)
    WHERE intent_event_sequence IS NOT NULL
  `;
});
