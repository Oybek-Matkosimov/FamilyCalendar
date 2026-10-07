/**
 * Runs once when the server starts. Configuration is validated immediately (the process exits with a clear
 * message if something is missing) and, when AUTO_MIGRATE=true, database migrations are applied before the
 * first request. Migrations are forward-only and lock-protected, so several instances can start together.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs' && process.env.NEXT_PHASE !== 'phase-production-build') {
    const { startup } = await import('./instrumentation-node');
    await startup();
  }
}
