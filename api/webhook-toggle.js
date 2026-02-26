/**
 * GET  /api/webhook-toggle
 * POST /api/webhook-toggle?enabled=true|false
 *
 * Persists webhook processing state in Redis.
 */
const { getWebhookEnabled, setWebhookEnabled } = require('../lib/helpers');

function parseToggleValue(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  return null;
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const enabled = await getWebhookEnabled();
    return res.status(200).json({ status: 'ok', enabled });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const current = await getWebhookEnabled();
  const parsed = parseToggleValue(req.query.enabled);
  const next = parsed === null ? !current : parsed;

  try {
    const enabled = await setWebhookEnabled(next);
    return res.status(200).json({ status: 'ok', enabled });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
