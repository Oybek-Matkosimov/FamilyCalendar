import { logger } from './logger';

/**
 * Tiny in-process domain event bus. Realtime sync uses it today; reminders / email / push notifications
 * can subscribe later without touching the services.
 */
export type DomainEventName = 'event.created' | 'event.updated' | 'event.deleted' | 'conflict.detected';
export interface DomainEventPayload {
  calendarId: string;
  eventId?: string;
}
type Subscriber = (name: DomainEventName, payload: DomainEventPayload) => void;

const subscribers = new Set<Subscriber>();

export function onDomainEvent(cb: Subscriber): () => void {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

export function emitDomainEvent(name: DomainEventName, payload: DomainEventPayload): void {
  for (const cb of subscribers) {
    try {
      cb(name, payload);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err), name }, 'domain event subscriber failed');
    }
  }
}
