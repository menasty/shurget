// services/analytics.js — GA4 event helpers
// Fires events to the global gtag() function on the client side.
// Does NOT make server-side calls — all events are emitted via EJS-rendered script tags.

/**
 * Returns a gtag() call string for a given event name and params object.
 * Usage in EJS: <script><%- analytics.event('driver_signup_started', {city: 'Phoenix'}) %></script>
 */
function event(name, params = {}) {
  const p = Object.entries(params)
    .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
    .join(', ');
  return `gtag('event', ${JSON.stringify(name)}, {${p}});`;
}

module.exports = { event };