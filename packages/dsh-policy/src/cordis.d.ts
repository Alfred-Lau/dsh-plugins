/**
 * Event channels this plugin consumes, declared onto the shared Cordis
 * `Events` interface (module augmentation — the standard way Cordis plugins
 * register typed channels).
 *
 * `tools/pre-execute` sits on the tool-execution approval chain: a listener
 * may return a verdict object to short-circuit the call. If a future dsh
 * release renames a channel or changes the verdict protocol, this file is
 * the only place that needs updating.
 */
import type {} from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Events {
    /** Waterfall hook before a tool executes; return a verdict to short-circuit. */
    'tools/pre-execute'(payload: unknown): unknown
    /** Fired after a tool result becomes durable (audit enrichment). */
    'tools/post-execute'(payload: unknown): void
  }
}
