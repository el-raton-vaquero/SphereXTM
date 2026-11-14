// FITS DATE-OBS uses TIMESYS=UTC but commonly omits a "Z" suffix.
// Never let the browser's local timezone shift the displayed observing date.
export function formatObservationDateUTC(value: string, locale = 'es') {
  const timestamp = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T00:00:00Z`
    : /(?:Z|[+-]\d{2}:\d{2})$/i.test(value) ? value : `${value}Z`;
  return new Date(timestamp).toLocaleDateString(locale, {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  });
}
