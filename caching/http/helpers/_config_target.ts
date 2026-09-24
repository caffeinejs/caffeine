// What a route extension is handed: the route (or route group) whose config it writes into.
export type ConfigTarget = { config(key: string, value: unknown): unknown }
