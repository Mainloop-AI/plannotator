/**
 * ConfigStore — Unified config resolver for Plannotator
 *
 * Singleton that resolves settings with precedence:
 *   server config file > cookie > default
 *
 * Works both inside and outside React. React components subscribe
 * via useSyncExternalStore (see useConfig.ts).
 *
 * Server-synced settings automatically write back to ~/.plannotator/config.json
 * via a debounced POST /api/config.
 */

import { SETTINGS, type SettingName, type SettingsMap } from './settings';

type Listener = () => void;

/** Deep-merge source into target, recursing into plain objects. */
function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(source)) {
    if (
      typeof target[key] === 'object' && target[key] !== null && !Array.isArray(target[key]) &&
      typeof source[key] === 'object' && source[key] !== null && !Array.isArray(source[key])
    ) {
      deepMerge(target[key] as Record<string, unknown>, source[key] as Record<string, unknown>);
    } else {
      target[key] = source[key];
    }
  }
}

/** Server write-back transport: posts a batch of changed server-synced settings. */
export type ServerSyncFn = (payload: Record<string, unknown>) => void;

/** Default = today's inline POST /api/config (best-effort). */
const defaultServerSync: ServerSyncFn = (payload) => {
  fetch('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).catch(() => {}); // best-effort
};

/** Infer the value type from a SettingDef */
type SettingValue<K extends SettingName> = SettingsMap[K] extends { defaultValue: infer D }
  ? D extends (...args: unknown[]) => infer R ? R : D
  : never;

class ConfigStore {
  private values = new Map<string, unknown>();
  private listeners = new Set<Listener>();
  private version = 0;
  private pendingServerWrites: Record<string, unknown> = {};
  private serverSyncTimer: ReturnType<typeof setTimeout> | null = null;
  private serverSync: ServerSyncFn = defaultServerSync;

  constructor() {
    // Eagerly resolve all settings from synchronous sources (cookie > default).
    // The store is safe to read from the moment it's created.
    for (const [name, def] of Object.entries(SETTINGS)) {
      const fromCookie = def.fromCookie();
      const defaultVal = typeof def.defaultValue === 'function'
        ? (def.defaultValue as () => unknown)()
        : def.defaultValue;
      const resolved = fromCookie ?? defaultVal;
      this.values.set(name, resolved);
      // Persist generated defaults to cookie so the value is stable across calls
      if (fromCookie === undefined) {
        def.toCookie(resolved as never);
      }
    }
  }

  /**
   * Re-hydrate all settings from the currently installed StorageBackend.
   * ADDITIVE host hook — Plannotator never calls this (eager cookie default unchanged).
   * Host installs a SYNCHRONOUS StorageBackend serving prefetched settings, then calls
   * this to route the initial load through that backend. Precedence after a host call:
   * server (init) > host backend (loadFromBackend) > cookie/default (constructor).
   * Call this BEFORE init(serverConfig): init() always wins, so calling loadFromBackend()
   * after init() would silently overwrite server-supplied settings.
   */
  loadFromBackend(): void {
    for (const [name, def] of Object.entries(SETTINGS)) {
      const fromBackend = def.fromCookie();
      if (fromBackend !== undefined) {
        this.values.set(name, fromBackend);
      }
    }
    this.notify();
  }

  /**
   * Apply server config overrides.
   * Call once after fetching /api/plan or /api/diff.
   *
   * Server values take precedence over the cookie/default already resolved
   * by the constructor. Settings without a server value are left untouched.
   */
  init(serverConfig?: Record<string, unknown>): void {
    if (serverConfig) {
      for (const [name, def] of Object.entries(SETTINGS)) {
        if (def.serverKey && def.fromServer) {
          const fromServer = def.fromServer(serverConfig);
          if (fromServer !== undefined) {
            this.values.set(name, fromServer);
            def.toCookie(fromServer as never);
          }
        }
      }
    }
    this.notify();
  }

  /** Get a resolved config value. Works outside React. */
  get<K extends SettingName>(key: K): SettingValue<K> {
    return this.values.get(key) as SettingValue<K>;
  }

  /** Set a config value. Writes cookie (sync), queues server write-back if applicable. */
  set<K extends SettingName>(key: K, value: SettingValue<K>): void {
    const def = SETTINGS[key];
    this.values.set(key, value);
    def.toCookie(value as never);

    if (def.serverKey && def.toServer) {
      deepMerge(this.pendingServerWrites, def.toServer(value as never) as Record<string, unknown>);
      this.scheduleServerSync();
    }

    this.notify();
  }

  /** Subscribe to changes. Returns unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Override the server write-back transport (default = inline POST /api/config). */
  setServerSync(fn: ServerSyncFn): void {
    this.serverSync = fn;
  }

  resetServerSync(): void { this.serverSync = defaultServerSync; }

  private notify(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private scheduleServerSync(): void {
    if (this.serverSyncTimer) clearTimeout(this.serverSyncTimer);
    this.serverSyncTimer = setTimeout(() => {
      const payload = { ...this.pendingServerWrites };
      this.pendingServerWrites = {};
      this.serverSync(payload);
    }, 300);
  }
}

export const configStore = new ConfigStore();
export type { SettingValue };
