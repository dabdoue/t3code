// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ProviderInstanceId,
  PiAgentSettings,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const decodePiSettings = Schema.decodeSync(PiAgentSettings);

const piAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakePiTurn {
  /** Text streamed as two deltas before the tool run. */
  readonly reply: string;
  readonly usage?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
}

/**
 * A stand-in for `pi --mode rpc`: it answers the session commands the adapter
 * sends on start, then plays one scripted agent run (deltas → bash tool →
 * final assistant message → settle) for every prompt it accepts. With
 * `hold: true` the run instead stalls after `agent_start` until an `abort`
 * arrives, and finishes with an `aborted` stop reason. Every command lands in
 * the request log so tests can assert on the exact wire conversation.
 */
async function makeFakePi(input: {
  readonly turn?: FakePiTurn;
  readonly hold?: boolean;
  readonly requestLogPath?: string;
}) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-rpc-mock-"));
  const turn = input.turn ?? {
    reply: "Hello world",
    usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 10 },
  };
  return writeFakeCli({
    directory: dir,
    name: "pi",
    env: {
      T3_FAKE_PI_TURN: JSON.stringify(turn),
      T3_FAKE_PI_HOLD: input.hold === true ? "1" : "",
      ...(input.requestLogPath ? { T3_FAKE_PI_REQUEST_LOG: input.requestLogPath } : {}),
    },
    source: [
      'import * as NodeFS from "node:fs";',
      "let buffer = '';",
      'const requestLogPath = process.env.T3_FAKE_PI_REQUEST_LOG ?? "";',
      "const turn = JSON.parse(process.env.T3_FAKE_PI_TURN ?? '{}');",
      'const hold = process.env.T3_FAKE_PI_HOLD === "1";',
      "const send = (payload) => process.stdout.write(JSON.stringify(payload) + '\\n');",
      "const logRequest = (command) => {",
      "  if (requestLogPath) NodeFS.appendFileSync(requestLogPath, JSON.stringify(command) + '\\n');",
      "};",
      "const runToCompletion = (stopReason) => {",
      "  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: turn.reply.slice(0, 6) } });",
      "  send({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: turn.reply.slice(6) } });",
      "  send({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash', args: { command: 'echo hi' } });",
      "  send({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash', result: { content: [{ type: 'text', text: 'hi' }] }, isError: false });",
      "  if (turn.usage) {",
      "    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: turn.reply }], stopReason, usage: { ...turn.usage, totalTokens: turn.usage.input + turn.usage.output } } });",
      "  }",
      "  send({ type: 'agent_settled' });",
      "};",
      "let heldRun = false;",
      "const handle = (command) => {",
      "  logRequest(command);",
      "  const respond = (data) => send({ id: command.id, type: 'response', command: command.type, success: true, data });",
      "  if (command.type === 'get_state') {",
      "    respond({ sessionId: 'pi-session-1', sessionFile: '/tmp/pi-session-1.jsonl' });",
      "    return;",
      "  }",
      "  if (command.type === 'prompt') {",
      "    respond({});",
      "    send({ type: 'agent_start' });",
      "    if (hold) {",
      "      heldRun = true;",
      "    } else {",
      "      runToCompletion('stop');",
      "    }",
      "    return;",
      "  }",
      "  if (command.type === 'abort') {",
      "    respond({});",
      "    if (heldRun) {",
      "      heldRun = false;",
      "      runToCompletion('aborted');",
      "    }",
      "    return;",
      "  }",
      "  respond({});",
      "};",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => {",
      "  buffer += chunk;",
      "  let newlineIndex;",
      "  while ((newlineIndex = buffer.indexOf('\\n')) !== -1) {",
      "    const line = buffer.slice(0, newlineIndex);",
      "    buffer = buffer.slice(newlineIndex + 1);",
      "    if (!line.trim()) continue;",
      "    let command;",
      "    try { command = JSON.parse(line); } catch { continue; }",
      "    handle(command);",
      "  }",
      "});",
      "",
    ].join("\n"),
  });
}

const makeTestAdapter = (binaryPath: string) =>
  makePiAdapter(decodePiSettings({ binaryPath }), { environment: process.env }).pipe(Effect.orDie);

it.layer(piAdapterTestLayer)("PiAdapterLive", (it) => {
  it.effect("translates a full rpc turn into runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-requests-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const piPath = yield* Effect.promise(() => makeFakePi({ requestLogPath }));

      const adapter = yield* makeTestAdapter(piPath);
      const events: ProviderRuntimeEvent[] = [];
      const settled = yield* Deferred.make<void>();
      const idle = yield* Deferred.make<void>();
      // turn.completed lands before the matching "ready" state change, so the
      // idle signal only counts ready events observed after the turn ends.
      let turnDone = false;
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "turn.completed") {
            turnDone = true;
            yield* Deferred.succeed(settled, undefined);
          }
          if (
            event.type === "session.state.changed" &&
            event.payload.state === "ready" &&
            turnDone
          ) {
            yield* Deferred.succeed(idle, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        cwd: tempDir,
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("piAgent"),
          model: "vllm/qwen3",
        },
      });
      const turn = yield* adapter.sendTurn({ threadId, input: "say hi" });
      yield* Deferred.await(settled).pipe(Effect.timeout("5 seconds"));
      yield* Deferred.await(idle).pipe(Effect.timeout("5 seconds"));
      yield* Fiber.interrupt(eventsFiber);

      // Session start: pi reported its session, and the model selection was
      // split into pi's provider/model pair before the first prompt.
      const threadStarted = events.find((event) => event.type === "thread.started");
      assert.equal(threadStarted?.payload.providerThreadId, "pi-session-1");

      const requests = (yield* Effect.promise(() => NodeFSP.readFile(requestLogPath, "utf8")))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      assert.deepEqual(
        requests.map((command) => command.type),
        ["get_state", "set_model", "set_session_name", "prompt"],
      );
      assert.deepEqual(requests[1], {
        id: requests[1]?.id,
        type: "set_model",
        provider: "vllm",
        modelId: "qwen3",
      });
      assert.equal(requests[2]?.name, threadId);

      // The prompt carries the user text plus the shared runtime preamble.
      const promptMessage = String(requests[3]?.message ?? "");
      assert.ok(promptMessage.startsWith("say hi"));
      assert.notEqual(promptMessage, "say hi");

      // Turn lifecycle: streaming text, the bash tool as a command execution
      // item, and a completed turn whose usage folds pi's cache counters in.
      assert.equal(turn.threadId, threadId);
      assert.ok(turn.turnId.length > 0);
      const deltas = events.filter((event) => event.type === "content.delta");
      assert.equal(deltas.length, 2);
      assert.equal(deltas[0]?.payload.streamKind, "assistant_text");
      assert.equal(deltas[0]?.payload.delta, "Hello ");
      const toolStarted = events.find((event) => event.type === "item.started");
      assert.equal(toolStarted?.payload.itemType, "command_execution");
      assert.equal(toolStarted?.payload.title, "bash");
      assert.equal(toolStarted?.itemId, "tool-1");
      const toolCompleted = events.find((event) => event.type === "item.completed");
      assert.equal(toolCompleted?.payload.status, "completed");
      assert.equal(toolCompleted?.payload.detail, "hi");
      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.turnId, turn.turnId);
      assert.equal(turnCompleted?.payload.state, "completed");
      assert.equal(turnCompleted?.payload.stopReason, "stop");
      assert.equal(turnCompleted?.payload.tokenUsage?.inputTokens, 160);
      assert.equal(turnCompleted?.payload.tokenUsage?.outputTokens, 20);
      assert.equal(turnCompleted?.payload.tokenUsage?.cachedInputTokens, 50);
      assert.equal(turnCompleted?.payload.tokenUsage?.usageStatus, "complete");

      // The run is idle once agent_settled lands.
      const lastState = events.findLast((event) => event.type === "session.state.changed");
      assert.equal(lastState?.payload.state, "ready");

      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("marks the turn interrupted when an abort lands mid-run", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("pi-adapter-abort");
      const piPath = yield* Effect.promise(() =>
        makeFakePi({
          hold: true,
          turn: { reply: "partial", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
        }),
      );

      const adapter = yield* makeTestAdapter(piPath);
      const events: ProviderRuntimeEvent[] = [];
      const running = yield* Deferred.make<void>();
      const settled = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          events.push(event);
          if (event.type === "session.state.changed" && event.payload.state === "running") {
            yield* Deferred.succeed(running, undefined);
          }
          if (event.type === "turn.completed") yield* Deferred.succeed(settled, undefined);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "long task" });
      yield* Deferred.await(running).pipe(Effect.timeout("5 seconds"));
      yield* adapter.interruptTurn(threadId);
      yield* Deferred.await(settled).pipe(Effect.timeout("5 seconds"));
      // Stop before draining the events fiber so the graceful exit is captured.
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);

      const turnCompleted = events.find((event) => event.type === "turn.completed");
      assert.equal(turnCompleted?.payload.state, "interrupted");
      assert.equal(turnCompleted?.payload.stopReason, "aborted");

      const exited = events.find((event) => event.type === "session.exited");
      assert.equal(exited?.payload.exitKind, "graceful");
    }).pipe(TestClock.withLive),
  );
});
