import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { migrationEntries, migrationManifest, runMigrations } from "./Migrations.ts";
import AuthSessionClientConnection from "./Migrations/041_AuthSessionClientConnection.ts";
import ThreadLinkedPullRequest from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import ThreadsUnsettledAt from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";

const seedFork = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 40 });
  yield* AuthSessionClientConnection;
  yield* ThreadLinkedPullRequest;
  yield* ThreadsUnsettledAt;
  yield* sql`ALTER TABLE projection_turns ADD COLUMN intent_event_sequence INTEGER`;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at) VALUES
      (41, 'ProjectionTurnIntentSequence', '2026-08-12 09:29:43'),
      (45, 'AuthSessionClientConnection', '2026-09-02 23:22:55'),
      (46, 'ProjectionThreadLinkedPullRequest', '2026-09-02 23:22:55'),
      (47, 'ProjectionThreadsUnsettledAt', '2026-09-02 23:22:55'),
      (48, 'ClearAutomaticProjectModelDefaults', '2026-09-02 23:22:55')
  `;
});

describe("fork migration reconciliation", () => {
  it.effect(
    "repairs skipped changes once, preserving history, events, and later project choices",
    () => {
      const messages: Array<unknown> = [];
      const logger = Logger.make(({ message }) => messages.push(message));
      return Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* seedFork;
        const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const selection = '{"instanceId":"codex","model":"chosen-later"}';
        yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, default_model_selection_json, created_at, updated_at
        ) VALUES ('project', 'Project', '/project', '[]', ${selection}, '2026-05-01', '2026-09-03')
      `;
        yield* sql`
        INSERT INTO projection_threads (
          thread_id, project_id, title, model_selection_json, created_at, updated_at, settled_override, settled_at
        ) VALUES ('thread', 'project', 'Thread', ${selection}, '2026-05-01', '2026-09-03', 'settled', '2026-09-01')
      `;
        yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, correlation_id, actor_kind, payload_json, metadata_json
        ) VALUES
          ('created', 'project', 'project', 0, 'project.created', '2026-05-01',
           'create', 'create', 'client', '{"defaultModelSelection":{"model":"seeded"}}', '{}'),
          ('settled', 'thread', 'thread', 0, 'thread.settled', '2026-09-01',
           'server:auto-settle:thread:uuid', 'settle', 'server', '{"settledAt":"2026-09-01"}', '{}')
      `;
        const events = yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`;

        yield* runMigrations({ toMigrationInclusive: 48 });
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          history,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM orchestration_events ORDER BY sequence`,
          events,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT default_model_selection_json FROM projection_projects`,
          [{ default_model_selection_json: selection }],
        );
        assert.deepStrictEqual(yield* sql`SELECT settled_at FROM projection_threads`, [
          { settled_at: "2026-05-01" },
        ]);
        for (const [table, expected] of [
          ["auth_sessions", ["client_surface", "client_app_version"]],
          ["projection_projects", ["auto_pull", "project_icon_json"]],
          [
            "projection_threads",
            ["linked_pull_request_json", "unsettled_at", "branch_pull_request_json"],
          ],
        ] as const) {
          const columns = yield* sql<{
            readonly name: string;
          }>`PRAGMA table_info(${sql.literal(table)})`;
          for (const name of expected)
            assert.isTrue(columns.some((column) => column.name === name));
        }
        // A later user edit must survive subsequent starts.
        yield* sql`UPDATE projection_threads SET settled_at = '2026-09-01'`;
        assert.deepStrictEqual(
          yield* runMigrations(),
          migrationManifest.filter(([id]) => id > 48),
        );
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(yield* sql`SELECT settled_at FROM projection_threads`, [
          { settled_at: "2026-09-01" },
        ]);
        assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migration_repairs`).length, 1);
        assert.isFalse(messages.some((message) => String(message).includes("history diverges")));
      }).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
        Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
      );
    },
  );

  it.effect("keeps canonical upgrades unchanged", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(yield* runMigrations(), migrationManifest);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migration_repairs'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("repairs a fork already upgraded to V2 without changing its event history", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedFork;
      // Reproduce an older build that skipped the colliding migrations and
      // already created V2, as the installed database has done.
      yield* Migrator.make({})({
        loader: Migrator.fromRecord(
          Object.fromEntries(
            migrationEntries
              .filter(([id]) => id > 48)
              .map(([id, name, migration]) => [`${id}_${name}`, migration]),
          ),
        ),
      });
      yield* sql`
        INSERT INTO orchestration_v2_events (
          event_id, thread_id, event_type, occurred_at, payload_json
        ) VALUES ('v2-event', 'v2-thread', 'thread.created', '2026-10-11', '{"title":"Preserve"}')
      `;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const events = yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`;
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(yield* runMigrations(), []);
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM orchestration_v2_events ORDER BY sequence`,
        events,
      );
      assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migration_repairs`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("retains warnings for unrecognized histories without marking them repaired", () => {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => messages.push(message));
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedFork;
      yield* sql`UPDATE effect_sql_migrations SET name = 'UnknownForkMigration' WHERE migration_id = 45`;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      yield* runMigrations({ toMigrationInclusive: 48 });
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migration_repairs'`,
        [],
      );
      assert.isTrue(messages.some((message) => String(message).includes("history diverges")));
    }).pipe(
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
    );
  });

  it.effect("rolls back a failed repair and retries without losing the original ledger", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* seedFork;
      const history = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const [turns] = yield* sql<{ readonly sql: string }>`
        SELECT sql FROM sqlite_master WHERE name = 'projection_turns'
      `;
      yield* sql`DROP TABLE projection_turns`;
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(runMigrations({ toMigrationInclusive: 48 }))),
      );
      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        history,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migration_repairs'`,
        [],
      );
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
      assert.isFalse(columns.some((column) => column.name === "auto_pull"));
      yield* sql.unsafe(turns!.sql);
      yield* runMigrations({ toMigrationInclusive: 48 });
      assert.strictEqual((yield* sql`SELECT * FROM effect_sql_migration_repairs`).length, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
