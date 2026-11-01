const Sentry = require('@sentry/nextjs');

Sentry.init({
  tracesSampleRate: 1,
});
