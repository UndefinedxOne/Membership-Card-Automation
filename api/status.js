/**
 * GET /api/status
 * 
 * Returns server config status and stats.
 */
const { getConfig, getLogs, getWebhookEnabled, isRedisAvailable } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cfg = getConfig();
  const logs = await getLogs();
  const webhookEnabled = await getWebhookEnabled();

  const redisAvailable = isRedisAvailable();

  return res.status(200).json({
    status: 'running',
    platform: 'vercel-serverless',
    config: {
      acuityConfigured: !!(cfg.ACUITY_USER_ID && cfg.ACUITY_API_KEY),
      passKitConfigured: !!(cfg.PASSKIT_API_KEY && cfg.PASSKIT_API_SECRET),
      programId: cfg.PASSKIT_PROGRAM_ID ? '✓ Set' : '✗ Missing',
      tierId: '✓ Fixed: membership',
      membershipFilter: cfg.MEMBERSHIP_PRODUCT_FILTER || '(none — all orders processed)',
    },
    webhookUrl: '/webhook/acuity',
    webhookEnabled,
    webhookToggleAvailable: true,
    webhookTogglePersistent: redisAvailable,
    totalProcessed: logs.filter(l => l.message && l.message.includes('Successfully created')).length,
    totalErrors: logs.filter(l => l.level === 'error').length,
    redisAvailable,
    kvAvailable: redisAvailable,
  });
};
