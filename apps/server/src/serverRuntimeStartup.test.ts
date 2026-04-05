import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Ref } from "effect";
import * as Stream from "effect/Stream";

import { ProjectId, ThreadId, type OrchestrationCommand } from "@t3tools/contracts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { ServerConfig } from "./config.ts";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  launchStartupHeartbeat,
  makeCommandGate,
  prepareAutoBootstrapWelcome,
  ServerRuntimeStartupError,
} from "./serverRuntimeStartup.ts";

it.effect("enqueueCommand waits for readiness and then drains queued work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const executionCount = yield* Ref.make(0);
      const commandGate = yield* makeCommandGate;

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Ref.updateAndGet(executionCount, (count) => count + 1))
        .pipe(Effect.forkScoped);

      yield* Effect.yieldNow;
      assert.equal(yield* Ref.get(executionCount), 0);

      yield* commandGate.signalCommandReady;

      const result = yield* Fiber.join(queuedCommandFiber);
      assert.equal(result, 1);
      assert.equal(yield* Ref.get(executionCount), 1);
    }),
  ),
);

it.effect("enqueueCommand fails queued work when readiness fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const commandGate = yield* makeCommandGate;
      const failure = yield* Deferred.make<void, never>();

      const queuedCommandFiber = yield* commandGate
        .enqueueCommand(Deferred.await(failure).pipe(Effect.as("should-not-run")))
        .pipe(Effect.forkScoped);

      yield* commandGate.failCommandReady(
        new ServerRuntimeStartupError({
          message: "startup failed",
        }),
      );

      const error = yield* Effect.flip(Fiber.join(queuedCommandFiber));
      assert.equal(error.message, "startup failed");
    }),
  ),
);

it.effect("launchStartupHeartbeat does not block the caller while counts are loading", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const releaseCounts = yield* Deferred.make<void, never>();

      yield* launchStartupHeartbeat.pipe(
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () =>
            Deferred.await(releaseCounts).pipe(
              Effect.as({
                projectCount: 2,
                threadCount: 3,
              }),
            ),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.succeed(Option.none()),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(AnalyticsService, {
          record: () => Effect.void,
          flush: Effect.void,
        }),
      );
    }),
  ),
);

it.effect(
  "prepareAutoBootstrapWelcome creates a project and returns a draft bootstrap thread for explicit cwd launches",
  () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];

      const welcome = yield* prepareAutoBootstrapWelcome.pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(ServerConfig, {
          logLevel: "Info",
          traceMinLevel: "Info",
          traceTimingEnabled: true,
          traceBatchWindowMs: 200,
          traceMaxBytes: 10,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "t3-server",
          mode: "desktop",
          port: 3773,
          host: "127.0.0.1",
          cwd: "/tmp/project-explicit",
          baseDir: "/tmp/t3-explicit",
          stateDir: "/tmp/t3-explicit/state",
          dbPath: "/tmp/t3-explicit/state.sqlite",
          keybindingsConfigPath: "/tmp/t3-explicit/keybindings.json",
          settingsPath: "/tmp/t3-explicit/settings.json",
          worktreesDir: "/tmp/t3-explicit/worktrees",
          attachmentsDir: "/tmp/t3-explicit/attachments",
          logsDir: "/tmp/t3-explicit/logs",
          serverLogPath: "/tmp/t3-explicit/logs/server.log",
          serverTracePath: "/tmp/t3-explicit/logs/server.trace.ndjson",
          providerLogsDir: "/tmp/t3-explicit/logs/provider",
          providerEventLogPath: "/tmp/t3-explicit/logs/provider/events.log",
          terminalLogsDir: "/tmp/t3-explicit/logs/terminals",
          anonymousIdPath: "/tmp/t3-explicit/anonymous-id",
          staticDir: undefined,
          devUrl: undefined,
          noBrowser: true,
          authToken: undefined,
          autoBootstrapProjectFromCwd: true,
          logWebSocketEvents: false,
          bootstrapLaunchMode: "explicit-cwd",
        }),
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
          getFirstActiveThreadIdByProjectId: () => Effect.die("should not query existing thread"),
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          dispatch: (command) => {
            commands.push(command);
            return Effect.succeed({ sequence: commands.length });
          },
          streamDomainEvents: Stream.empty,
        }),
      );

      assert.equal(commands.length, 1);
      const firstCommand = commands[0];
      assert.equal(firstCommand?.type, "project.create");
      if (!firstCommand || firstCommand.type !== "project.create") {
        assert.fail("expected bootstrap to create a project");
      }
      assert.equal(welcome.bootstrapProjectId, firstCommand.projectId);
      assert.ok(welcome.bootstrapThreadId !== undefined);
      assert.equal(welcome.bootstrapThreadKind, "draft");
    }),
);

it.effect(
  "prepareAutoBootstrapWelcome reuses the earliest active thread for default launches",
  () =>
    Effect.gen(function* () {
      const projectId = ProjectId.makeUnsafe("project-default");
      const threadId = ThreadId.makeUnsafe("thread-default");
      let queriedFirstThread = false;

      const welcome = yield* prepareAutoBootstrapWelcome.pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(ServerConfig, {
          logLevel: "Info",
          traceMinLevel: "Info",
          traceTimingEnabled: true,
          traceBatchWindowMs: 200,
          traceMaxBytes: 10,
          traceMaxFiles: 1,
          otlpTracesUrl: undefined,
          otlpMetricsUrl: undefined,
          otlpExportIntervalMs: 10_000,
          otlpServiceName: "t3-server",
          mode: "desktop",
          port: 3773,
          host: "127.0.0.1",
          cwd: "/tmp/project-default",
          baseDir: "/tmp/t3-default",
          stateDir: "/tmp/t3-default/state",
          dbPath: "/tmp/t3-default/state.sqlite",
          keybindingsConfigPath: "/tmp/t3-default/keybindings.json",
          settingsPath: "/tmp/t3-default/settings.json",
          worktreesDir: "/tmp/t3-default/worktrees",
          attachmentsDir: "/tmp/t3-default/attachments",
          logsDir: "/tmp/t3-default/logs",
          serverLogPath: "/tmp/t3-default/logs/server.log",
          serverTracePath: "/tmp/t3-default/logs/server.trace.ndjson",
          providerLogsDir: "/tmp/t3-default/logs/provider",
          providerEventLogPath: "/tmp/t3-default/logs/provider/events.log",
          terminalLogsDir: "/tmp/t3-default/logs/terminals",
          anonymousIdPath: "/tmp/t3-default/anonymous-id",
          staticDir: undefined,
          devUrl: undefined,
          noBrowser: true,
          authToken: undefined,
          autoBootstrapProjectFromCwd: true,
          logWebSocketEvents: false,
          bootstrapLaunchMode: "default",
        }),
        Effect.provideService(ProjectionSnapshotQuery, {
          getSnapshot: () => Effect.die("unused"),
          getCounts: () => Effect.die("unused"),
          getActiveProjectByWorkspaceRoot: () =>
            Effect.succeed(
              Option.some({
                id: projectId,
                title: "default",
                workspaceRoot: "/tmp/project-default",
                defaultModelSelection: {
                  provider: "codex",
                  model: "gpt-5-codex",
                },
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }),
            ),
          getFirstActiveThreadIdByProjectId: () => {
            queriedFirstThread = true;
            return Effect.succeed(Option.some(threadId));
          },
          getThreadCheckpointContext: () => Effect.succeed(Option.none()),
        }),
        Effect.provideService(OrchestrationEngineService, {
          getReadModel: () => Effect.die("unused"),
          readEvents: () => Stream.empty,
          dispatch: () => Effect.die("should not create a new thread"),
          streamDomainEvents: Stream.empty,
        }),
      );

      assert.equal(queriedFirstThread, true);
      assert.equal(welcome.bootstrapProjectId, projectId);
      assert.equal(welcome.bootstrapThreadId, threadId);
      assert.equal(welcome.bootstrapThreadKind, "persisted");
    }),
);
