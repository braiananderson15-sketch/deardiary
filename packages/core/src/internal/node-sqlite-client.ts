import * as NodeSqlite from "node:sqlite";

import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { identity } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Reactivity from "effect/unstable/reactivity/Reactivity";
import * as Client from "effect/unstable/sql/SqlClient";
import type { Connection } from "effect/unstable/sql/SqlConnection";
import {
  AuthenticationError,
  AuthorizationError,
  classifySqliteError,
  ConnectionError,
  ConstraintError,
  LockTimeoutError,
  SqlError,
  UniqueViolation,
  UnknownError,
} from "effect/unstable/sql/SqlError";
import * as Statement from "effect/unstable/sql/Statement";

const databaseSystemAttribute = "db.system.name";
const sqliteConstraintUniqueCode = 2_067;

interface ClassifyOptions {
  readonly message?: string;
  readonly operation?: string;
}

const getNodeSqliteErrorCode = (cause: unknown): number | undefined => {
  if (typeof cause !== "object" || cause === null || !("errcode" in cause)) {
    return undefined;
  }
  return typeof cause.errcode === "number" ? cause.errcode : undefined;
};

const getUniqueConstraint = (cause: unknown): string => {
  if (typeof cause !== "object" || cause === null || !("message" in cause)) {
    return "unknown";
  }
  const message = cause.message;
  if (typeof message !== "string") {
    return "unknown";
  }
  const prefix = "UNIQUE constraint failed:";
  const index = message.indexOf(prefix);
  return index === -1 ? "unknown" : message.slice(index + prefix.length).trim() || "unknown";
};

const classifyNodeSqliteError = (cause: unknown, options: ClassifyOptions = {}) => {
  const classified = classifySqliteError(cause, options);
  if (!(classified instanceof UnknownError)) {
    return classified;
  }

  const extendedCode = getNodeSqliteErrorCode(cause);
  if (extendedCode === undefined) {
    return classified;
  }

  const props = { cause, ...options };
  if (extendedCode === sqliteConstraintUniqueCode) {
    return new UniqueViolation({
      ...props,
      constraint: getUniqueConstraint(cause),
    });
  }

  switch (extendedCode & 0xff) {
    case 23:
      return new AuthenticationError(props);
    case 3:
      return new AuthorizationError(props);
    case 19:
      return new ConstraintError(props);
    case 5:
    case 6:
      return new LockTimeoutError(props);
    case 14:
      return new ConnectionError(props);
    default:
      return classified;
  }
};

export interface NodeSqliteClientConfig {
  readonly filename: string;
  readonly prepareCacheSize?: number;
  readonly prepareCacheTTL?: Duration.Input;
  readonly spanAttributes?: Readonly<Record<string, unknown>>;
}

class UnsupportedNodeSqliteOperationError extends Schema.TaggedErrorClass<UnsupportedNodeSqliteOperationError>()(
  "UnsupportedNodeSqliteOperationError",
  {},
) {
  override get message(): string {
    return "The native node:sqlite client does not support streaming query results.";
  }
}

const make = Effect.fn("NodeSqliteClient.make")(function* (
  options: NodeSqliteClientConfig,
): Effect.fn.Return<Client.SqlClient, SqlError, Scope.Scope | Reactivity.Reactivity> {
  const compiler = Statement.makeCompilerSqlite();

  const makeConnection = Effect.gen(function* () {
    const scope = yield* Effect.scope;
    const database = yield* Effect.try({
      try: () => new NodeSqlite.DatabaseSync(options.filename),
      catch: (cause) =>
        new SqlError({
          reason: classifyNodeSqliteError(cause, {
            message: "Failed to open database",
            operation: "open",
          }),
        }),
    });

    yield* Scope.addFinalizer(
      scope,
      Effect.try({
        try: () => database.close(),
        catch: (cause) =>
          new SqlError({
            reason: classifyNodeSqliteError(cause, {
              message: "Failed to close database",
              operation: "close",
            }),
          }),
      }).pipe(Effect.orDie),
    );

    const statementReaderCache = new WeakMap<NodeSqlite.StatementSync, boolean>();
    const hasRows = (statement: NodeSqlite.StatementSync): boolean => {
      const cached = statementReaderCache.get(statement);
      if (cached !== undefined) {
        return cached;
      }

      const value = statement.columns().length > 0;
      statementReaderCache.set(statement, value);
      return value;
    };

    const prepare = (sql: string) =>
      Effect.try({
        try: () => database.prepare(sql),
        catch: (cause) =>
          new SqlError({
            reason: classifyNodeSqliteError(cause, {
              message: "Failed to prepare statement",
              operation: "prepare",
            }),
          }),
      });

    const prepareCache = yield* Cache.make({
      capacity: options.prepareCacheSize ?? 200,
      timeToLive: options.prepareCacheTTL ?? Duration.minutes(10),
      lookup: prepare,
    });

    const runStatement = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
      raw: boolean,
    ) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        try {
          statement.setReadBigInts(Boolean(Context.get(fiber.context, Client.SafeIntegers)));
          if (hasRows(statement)) {
            return Effect.succeed(statement.all(...(params as any)));
          }

          const result = statement.run(...(params as any));
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : []);
        } catch (cause) {
          return Effect.fail(
            new SqlError({
              reason: classifyNodeSqliteError(cause, {
                message: "Failed to execute statement",
                operation: "execute",
              }),
            }),
          );
        }
      });

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatement(statement, params, raw),
      );

    const runStatementValues = (
      statement: NodeSqlite.StatementSync,
      params: ReadonlyArray<unknown>,
    ) =>
      Effect.acquireUseRelease(
        Effect.succeed(statement),
        (preparedStatement) =>
          Effect.try({
            try: () => {
              if (hasRows(preparedStatement)) {
                preparedStatement.setReturnArrays(true);
                return preparedStatement.all(...(params as any)) as unknown as ReadonlyArray<
                  ReadonlyArray<unknown>
                >;
              }

              preparedStatement.run(...(params as any));
              return [];
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyNodeSqliteError(cause, {
                  message: "Failed to execute statement",
                  operation: "execute",
                }),
              }),
          }),
        (preparedStatement) =>
          Effect.try({
            try: () => {
              if (hasRows(preparedStatement)) {
                preparedStatement.setReturnArrays(false);
              }
            },
            catch: (cause) =>
              new SqlError({
                reason: classifyNodeSqliteError(cause, {
                  message: "Failed to reset statement result mode",
                  operation: "resetResultMode",
                }),
              }),
          }).pipe(Effect.orDie),
      );

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (statement) =>
        runStatementValues(statement, params),
      );

    return identity<Connection>({
      execute(sql, params, rowTransform) {
        return rowTransform ? Effect.map(run(sql, params), rowTransform) : run(sql, params);
      },
      executeRaw(sql, params) {
        return run(sql, params, true);
      },
      executeValues(sql, params) {
        return runValues(sql, params);
      },
      executeValuesUnprepared(sql, params) {
        return Effect.flatMap(prepare(sql), (statement) =>
          runStatementValues(statement, params ?? []),
        );
      },
      executeUnprepared(sql, params, rowTransform) {
        const effect = prepare(sql).pipe(
          Effect.flatMap((statement) => runStatement(statement, params ?? [], false)),
        );
        return rowTransform ? Effect.map(effect, rowTransform) : effect;
      },
      executeStream(_sql, _params) {
        return Stream.die(new UnsupportedNodeSqliteOperationError());
      },
    });
  });

  const semaphore = yield* Semaphore.make(1);
  const connection = yield* makeConnection;
  const acquirer = semaphore.withPermits(1)(Effect.succeed(connection));
  const transactionAcquirer = Effect.uninterruptibleMask((restore) => {
    const fiber = Fiber.getCurrent()!;
    const scope = Context.getUnsafe(fiber.context, Scope.Scope);
    return Effect.as(
      Effect.tap(restore(semaphore.take(1)), () => Scope.addFinalizer(scope, semaphore.release(1))),
      connection,
    );
  });

  return yield* Client.make({
    acquirer,
    compiler,
    transactionAcquirer,
    spanAttributes: [
      ...(options.spanAttributes ? Object.entries(options.spanAttributes) : []),
      [databaseSystemAttribute, "sqlite"],
    ],
  });
});

export const layer = (options: NodeSqliteClientConfig): Layer.Layer<Client.SqlClient, SqlError> =>
  Layer.effect(Client.SqlClient, make(options)).pipe(Layer.provide(Reactivity.layer));
