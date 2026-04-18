import { Temporal } from '@js-temporal/polyfill';

export function getTimestamp(): string {
  return Temporal.Now.instant().toString();
}
