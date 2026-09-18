/**
 * Event channels this plugin consumes, declared onto the shared Cordis
 * `Events` interface (module augmentation — the standard way Cordis plugins
 * register typed channels).
 *
 * If a future dsh release renames a channel or changes a payload shape, this
 * file is the only place that needs updating.
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Durable session-log broadcast: turn / step / tool / llm events. */
    'session/event'(payload: unknown): void
    /** The harness asks pending session state to flush. */
    'session/flush'(): void
    /** A session was disposed; last chance to flush per-session state. */
    'session/disposed'(): void
  }
}
