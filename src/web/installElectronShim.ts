/**
 * Browser shim for `window.electronAPI`.
 *
 * The Biome renderer talks to the Electron main process through a single
 * typed bridge (`src/bridge.ts` -> `window.electronAPI.invoke/on`). In the
 * desktop app that bridge is provided by `electron/preload.ts`; there is no
 * such preload in a browser, so this module supplies a drop-in replacement so
 * the exact same renderer can run as a plain web app.
 *
 * The app is forced into SERVER mode (see `read-settings` below): it connects
 * to a remote Biome server over HTTP (`/health`, `/api/*`) and WebSocket
 * (`/ws`) — all standard browser APIs. Because of that, the whole
 * "standalone" surface (spawning/installing the local Python engine, native
 * windowing, on-disk seed/recording/background management, auto-update) is
 * irrelevant here and is stubbed with safe no-ops.
 *
 * The only channels that carry real behaviour on the web:
 *   - read/write-settings        -> localStorage, pinned to server mode
 *   - probe-server-health        -> real cross-origin fetch of `/health`
 *   - list-models / models-info  -> proxied to the server's `/api/*` routes
 * Everything else returns a shape-compatible default.
 */
import { settingsSchema, ENGINE_MODES, type Settings } from '../types/settings'
import defaultSeedUrl from '../../seeds/default.jpg?url'

const SETTINGS_KEY = 'biome.web.settings'
const DEFAULT_SEED_FILENAME = 'default.jpg'

let defaultSeedBase64Promise: Promise<string> | null = null

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      if (typeof result !== 'string' || !result.includes(',')) {
        reject(new Error('Failed to read the bundled default seed'))
        return
      }
      resolve(result.slice(result.indexOf(',') + 1))
    }
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read the bundled default seed'))
    reader.readAsDataURL(blob)
  })
}

function getDefaultSeedBase64(): Promise<string> {
  if (!defaultSeedBase64Promise) {
    defaultSeedBase64Promise = fetch(defaultSeedUrl)
      .then((response) => {
        if (!response.ok) throw new Error(`Failed to load the bundled default seed: HTTP ${response.status}`)
        return response.blob()
      })
      .then(blobToBase64)
  }
  return defaultSeedBase64Promise
}

async function getSeedImageBase64(filename: string): Promise<{ base64: string }> {
  if (filename !== DEFAULT_SEED_FILENAME) return { base64: '' }
  return { base64: await getDefaultSeedBase64() }
}

/**
 * The remote Biome server the web client should talk to. Baked in at build
 * time via `VITE_BIOME_SERVER_URL`; falls back to the page origin so a
 * same-origin deployment (server and UI behind one host) also works.
 */
const DEFAULT_SERVER_URL =
  ((import.meta.env.VITE_BIOME_SERVER_URL as string | undefined) || '').trim() || window.location.origin

function baseDefaults(): Settings {
  // `parse({})` materialises every schema default; we then pin the two fields
  // that make this a web/server-mode client.
  const defaults = settingsSchema.parse({}) as Settings
  return { ...defaults, engine_mode: ENGINE_MODES.SERVER, server_url: DEFAULT_SERVER_URL }
}

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return baseDefaults()
    const merged = settingsSchema.parse(JSON.parse(raw)) as Settings
    // There is no standalone engine in the browser, so always run in server
    // mode and never let server_url be empty (empty => localhost standalone).
    merged.engine_mode = ENGINE_MODES.SERVER
    if (!merged.server_url) merged.server_url = DEFAULT_SERVER_URL
    return merged
  } catch {
    return baseDefaults()
  }
}

function writeSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
  } catch {
    // Private-mode / quota failures are non-fatal; settings just won't persist.
  }
}

/** An `EngineStatus` that reports "fully installed, nothing to do locally" so
 *  the renderer never routes into the desktop-only install flow. */
function readyEngineStatus() {
  return {
    uv_installed: true,
    repo_cloned: true,
    dependencies_synced: true,
    server_running: false,
    server_port: null,
    server_log_path: null
  }
}

async function probeServerHealth(healthUrl: string, timeoutMs = 5000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(healthUrl, { signal: controller.signal, credentials: 'include' })
    if (!res.ok) return { ok: false, launched_from_standalone: false }
    let capabilities: unknown = undefined
    let launched = false
    try {
      const body = await res.json()
      capabilities = body?.capabilities
      launched = Boolean(body?.launched_from_standalone)
    } catch {
      // A 200 with an unparseable body still means reachable; the renderer
      // falls back to client-side capability prediction when capabilities
      // are absent.
    }
    return { ok: true, capabilities, launched_from_standalone: launched }
  } catch {
    return { ok: false, launched_from_standalone: false }
  } finally {
    clearTimeout(timer)
  }
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { credentials: 'include' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

/** Proxy the server's canonical picker list. Returns [] on any failure so the
 *  picker degrades to the default model rather than throwing. */
async function listModels(serverUrl?: string, backend?: string) {
  const base = (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, '')
  const qs = backend ? `?backend=${encodeURIComponent(backend)}` : ''
  try {
    const data = await getJson(`${base}/api/models${qs}`)
    return Array.isArray(data) ? data : []
  } catch {
    return []
  }
}

async function getModelsInfo(modelIds: string[], serverUrl?: string) {
  const base = (serverUrl || DEFAULT_SERVER_URL).replace(/\/$/, '')
  return Promise.all(
    (modelIds || []).map(async (id) => {
      try {
        const info = (await getJson(`${base}/api/model-info/${encodeURIComponent(id)}`)) as Record<string, unknown>
        return {
          id,
          size_bytes: (info?.size_bytes as number | null) ?? null,
          exists: Boolean(info?.exists ?? true),
          is_local: Boolean(info?.is_local ?? false),
          error: (info?.error as string | null) ?? null
        }
      } catch {
        // Keep the id usable on a flaky probe rather than locking the user out.
        return { id, size_bytes: null, exists: true, is_local: false, error: null }
      }
    })
  )
}

function runtimeDiagnosticsMeta() {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator)
  return {
    app_name: 'Biome (web)',
    app_version: (import.meta.env.VITE_BIOME_VERSION as string) || 'web',
    commit_hash: (import.meta.env.VITE_BIOME_COMMIT as string) || 'unknown',
    platform: 'web',
    arch: 'web',
    electron_version: '',
    chrome_version: '',
    node_version: '',
    locale: nav.language || 'en',
    is_packaged: true
  }
}

function systemDiagnostics() {
  const nav = typeof navigator !== 'undefined' ? navigator : ({} as Navigator)
  return {
    platform: 'web',
    release: '',
    version: nav.userAgent || '',
    arch: 'web',
    uptime_seconds: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) / 1000),
    total_memory_bytes: 0,
    free_memory_bytes: 0,
    cpu_model: 'web',
    cpu_cores: nav.hardwareConcurrency || 0,
    gpu: null,
    gpu_feature_status: {}
  }
}

type Handler = (...args: unknown[]) => unknown | Promise<unknown>

const handlers: Record<string, Handler> = {
  // --- Settings -------------------------------------------------------------
  'read-settings': () => readSettings(),
  'read-default-settings': () => baseDefaults(),
  'write-settings': (settings) => writeSettings(settings as Settings),
  'get-settings-path-str': () => `localStorage:${SETTINGS_KEY}`,
  'open-settings': () => undefined,

  // --- Models (proxied to the remote server) --------------------------------
  'list-models': (serverUrl, backend) => listModels(serverUrl as string, backend as string),
  'get-models-info': (ids, serverUrl) => getModelsInfo(ids as string[], serverUrl as string),
  'delete-cached-model': () => undefined,

  // --- Engine lifecycle (desktop-only; no-ops in server mode) ---------------
  'check-engine-status': () => readyEngineStatus(),
  'abort-engine-install': () => '',
  'unpack-server-files': () => '',
  'reinstall-engine': () => '',
  'nuke-and-reinstall-engine': () => '',

  // --- Local server lifecycle (desktop-only) --------------------------------
  'start-engine-server': () => '',
  'stop-engine-server': () => '',
  'is-server-running': () => false,
  'is-server-ready': () => false,
  'is-port-in-use': () => false,
  'probe-server-health': (healthUrl, timeoutMs) =>
    probeServerHealth(healthUrl as string, (timeoutMs as number) ?? 5000),
  'get-last-server-exit-tail': () => null,

  // --- Seeds (the bundled default is enough to bootstrap a web session) -----
  'list-seeds': () => [{ filename: DEFAULT_SEED_FILENAME, source: 'default', modifiedAt: 0 }],
  'get-seed-image-base64': (filename) => getSeedImageBase64(filename as string),
  'get-seed-thumbnail-base64': async (filename) => (await getSeedImageBase64(filename as string)).base64,
  'upload-seed': (filename) => ({ filename: filename as string, source: 'uploaded', modifiedAt: 0 }),
  'save-generated-seed': () => ({ filename: '', source: 'generated', modifiedAt: 0 }),
  'delete-seed': () => undefined,
  'get-seeds-dir-path': () => '',
  'open-seeds-dir': () => undefined,
  'read-image-files': () => [],

  // --- Backgrounds (ambient decoration) -------------------------------------
  'list-background-videos': () => [],

  // --- Window controls (browser has no native chrome) -----------------------
  'renderer-ready': () => undefined,
  'window-set-size': () => undefined,
  'window-get-size': () => ({ width: window.innerWidth, height: window.innerHeight }),
  'window-set-position': () => undefined,
  'window-get-position': () => ({ x: 0, y: 0 }),
  'window-minimize': () => undefined,
  'window-toggle-maximize': () => undefined,
  'window-close': () => undefined,
  'quit-app': () => undefined,

  // --- Debug / diagnostics --------------------------------------------------
  'write-spark-tuning': () => undefined,
  'get-runtime-diagnostics-meta': () => runtimeDiagnosticsMeta(),
  'get-system-diagnostics': () => systemDiagnostics(),
  'get-electron-log-tail': () => [],
  'export-loading-diagnostics': () => ({ ok: false, path: null, error: 'unsupported-on-web' }),

  // --- Updates (delivered by the web deploy itself) -------------------------
  'check-for-app-update': () => ({ updateAvailable: false, currentVersion: 'web', latestVersion: 'web' }),

  // --- Recordings (standalone-only feature) ---------------------------------
  'get-default-video-dir': () => '',
  'resolve-video-dir': () => '',
  'pick-video-dir': () => null,
  'list-recordings': () => [],
  'delete-recording': () => undefined,
  'open-recording-externally': () => undefined,
  'open-recordings-folder': () => undefined
}

export function installWebElectronAPI(): void {
  if (typeof window === 'undefined') return
  if ((window as unknown as { electronAPI?: unknown }).electronAPI) return

  const electronAPI = {
    invoke: async (channel: string, ...args: unknown[]): Promise<unknown> => {
      const handler = handlers[channel]
      if (!handler) {
        // Unknown channel: warn once and resolve undefined so a stray call
        // never rejects the renderer's boot path.
        console.warn(`[web-shim] unhandled IPC channel: ${channel}`)
        return undefined
      }
      return handler(...args)
    },
    // The only event the renderer listens for is `engine-log`, which is local
    // server stdout — there is no local server on the web, so this is a no-op
    // subscription returning an unlisten function.
    on: (_channel: string, _callback: (...args: unknown[]) => void): (() => void) => {
      return () => {}
    }
  }

  Object.defineProperty(window, 'electronAPI', { value: electronAPI, writable: false, configurable: false })
}

installWebElectronAPI()
