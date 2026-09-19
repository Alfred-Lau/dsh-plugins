/**
 * Event channels consumed by this plugin, declared onto the shared Cordis
 * `Events` interface (module augmentation). If a future dsh release renames a
 * channel, this file is the only place that needs updating.
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Waterfall hook before a tool executes; return a verdict to short-circuit. */
    'tools/pre-execute'(payload: unknown): unknown
    /** Fired after a tool result becomes durable (audit / cache-fill). */
    'tools/post-execute'(payload: unknown): void
    /** Harness session event broadcast (metering source). */
    'session/event'(payload: unknown): void
  }
}
