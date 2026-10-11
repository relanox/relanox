import type { CommonHost, StateNamespace, Storage, Observability } from "@relanox/sdk";
import type { Hono } from "hono";
import { z } from "zod";
import { CoreError } from "../errors.js";
import { validateJson } from "../json.js";
import { textId, limit } from "../validation.js";

/** Owns route registration and connection aggregation across all configured plugins. */
export function createCommonHostFactory(
  storage: Storage,
  observe: Observability,
  app: Hono,
  isAccepting: () => boolean,
  connections: Map<string, "connected" | "disconnected" | "degraded">,
) {
  const routes = new Set<string>();
  const componentPlugins = new Map<string, string>();
  function commonHost(namespace: StateNamespace, prefix: string): CommonHost {
    componentPlugins.set(prefix.slice(1), namespace.pluginId);
    return {
      observe,
      state: {
        get: (key) => storage.getState(namespace, textId.parse(key)),
        list: (input) => storage.listState(namespace, { ...input, limit: limit(input.limit) }),
        compareAndSet: (input) =>
          storage.compareAndSetState(namespace, {
            ...input,
            key: textId.parse(input.key),
            value: validateJson(input.value),
          }),
        delete: (key, version) =>
          storage.deleteState(
            namespace,
            textId.parse(key),
            z.number().int().positive().parse(version),
          ),
      },
      mountHttp(path, handler) {
        if (
          !path.startsWith("/") ||
          /[?#\\]|\.\.|\/\//u.test(path) ||
          !/^\/[A-Za-z0-9/_-]*\*?$/u.test(path)
        ) {
          throw new CoreError("invalid_route_path");
        }
        const route = prefix + (path === "/" ? "" : path);
        if (routes.has(route)) {
          throw new CoreError("duplicate_route");
        }
        routes.add(route);
        app.all(route, async (context) => {
          if (!isAccepting()) {
            return context.json({ error: "not_accepting" }, 503);
          }
          return handler(context.req.raw);
        });
      },
      connection(status, errorCode) {
        connections.set(prefix.slice(1), status);
        const allConnected = [...connections]
          .filter(([component]) => componentPlugins.get(component) === namespace.pluginId)
          .every(([, componentStatus]) => componentStatus === "connected");
        observe.record("relanox_connection_status", allConnected ? 1 : 0, {
          plugin: namespace.pluginId,
        });
        observe.log(status === "connected" ? "info" : "warn", "connection.changed", {
          plugin: namespace.pluginId,
          outcome: status === "connected" ? "ok" : "error",
          ...(errorCode ? { errorCode } : {}),
        });
      },
    };
  }

  return commonHost;
}
