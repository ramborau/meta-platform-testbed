import pg from 'pg';

// Durable storage for the one thing that genuinely hurts to lose: the tokens
// and asset IDs captured during onboarding. Without this, every redeploy forces
// the customer back through Embedded Signup.
//
// Events stay in memory on purpose - they are a debugging tail, not a record,
// and writing every webhook to Postgres would just add latency to the path that
// has to answer Meta within seconds.

const { Pool } = pg;

let pool = null;
let ready = false;

export function persistenceEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export async function initPersistence() {
  if (!persistenceEnabled()) return false;

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 3,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  // A dead database must not take the webhook receiver down with it.
  pool.on('error', (err) => console.error('[persist] pool error:', err.message));

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        key        text PRIMARY KEY,
        value      jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    ready = true;
    return true;
  } catch (err) {
    console.error('[persist] init failed, continuing in memory only:', err.message);
    ready = false;
    return false;
  }
}

export async function saveState(key, value) {
  if (!ready) return false;
  try {
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)]
    );
    return true;
  } catch (err) {
    console.error(`[persist] save "${key}" failed:`, err.message);
    return false;
  }
}

export async function loadState(key) {
  if (!ready) return null;
  try {
    const res = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
    return res.rows[0]?.value ?? null;
  } catch (err) {
    console.error(`[persist] load "${key}" failed:`, err.message);
    return null;
  }
}

export async function clearState(key) {
  if (!ready) return false;
  try {
    await pool.query('DELETE FROM app_state WHERE key = $1', [key]);
    return true;
  } catch {
    return false;
  }
}

export function persistenceStatus() {
  return { configured: persistenceEnabled(), connected: ready };
}
