import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import ThreadLinkedPullRequest from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import ThreadsUnsettledAt from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import ProjectsAutoPull from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import RepairAutomaticSettlementTimestamps from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import ProjectIcon from "./Migrations/047_ProjectionProjectIcon.ts";
import ThreadBranchPullRequest from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";

const forkHistory = new Map([
  [41, "ProjectionTurnIntentSequence"],
  [45, "AuthSessionClientConnection"],
  [46, "ProjectionThreadLinkedPullRequest"],
  [47, "ProjectionThreadsUnsettledAt"],
  [48, "ClearAutomaticProjectModelDefaults"],
]);

// This fork shipped different migrations at these ids. Preserve that ledger
// and repair the skipped mainline changes before a later migration uses them.
export const reconcileForkMigrationHistory = Effect.fn("reconcileForkMigrationHistory")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return new Map<number, string>();
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
          SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id IN (41, 45, 46, 47, 48)
        `;
        if (
          history.length !== forkHistory.size ||
          !history.every((row) => forkHistory.get(row.migration_id) === row.name)
        ) {
          return new Map<number, string>();
        }

        yield* sql`
          CREATE TABLE IF NOT EXISTS effect_sql_migration_repairs (
            name TEXT PRIMARY KEY,
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
          )
        `;
        const repaired = yield* sql`
          SELECT name FROM effect_sql_migration_repairs WHERE name = 'ForkMigrationIds41And45To48'
        `;
        if (repaired.length === 0) {
          yield* AuthSessionClientConnection;
          yield* ThreadLinkedPullRequest;
          yield* ThreadsUnsettledAt;
          yield* ProjectsAutoPull;
          yield* RepairAutomaticSettlementTimestamps;
          yield* ProjectIcon;
          yield* ThreadBranchPullRequest;
          // The fork already ran ClearAutomaticProjectModelDefaults at 48.
          // Replaying it would reset project choices made after that upgrade.
          yield* sql`
            INSERT INTO effect_sql_migration_repairs (name) VALUES ('ForkMigrationIds41And45To48')
          `;
          yield* Effect.logInfo(
            "Repaired known fork migration history; original records preserved",
          );
        }
        return forkHistory;
      }),
    );
  },
);
