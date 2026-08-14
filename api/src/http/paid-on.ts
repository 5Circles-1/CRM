import { badRequest } from './errors.ts';

/**
 * A user-picked payment date ("Paid on") → a timestamp that is never in the
 * future.
 *
 * The date means "that day, in IST". The old inline SQL pinned it to a fixed
 * hour of the day - which made TODAY read as a future timestamp for most of
 * the working day, so "Punch in a payment" with the default date refused
 * with "a payment cannot be dated in the future" before 6 PM IST. A past day
 * pins to 12:00 IST; today means "now"; a genuinely future day is refused
 * here, in plain words, before the database backstop ever sees it.
 */
export function paidOnToTimestamp(paidOn: string | undefined): string | null {
  if (!paidOn) return null;
  const istToday = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  if (paidOn > istToday) throw badRequest('a payment cannot be dated in the future');
  const noonIst = new Date(`${paidOn}T12:00:00+05:30`);
  return (noonIst.getTime() > Date.now() ? new Date() : noonIst).toISOString();
}
