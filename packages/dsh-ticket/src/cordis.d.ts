/**
 * Declares the `ticket` service onto the shared Cordis `Context` interface so
 * `inject: ['ticket']` and `ctx.ticket` type-check in this package and in the
 * governance packages that consume it.
 */
import type {} from '@deepseek-ai/cordis'
import type { TicketService } from './index.js'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Ticket scope service, provided by dsh-ticket-context. */
    ticket: TicketService
  }
}
