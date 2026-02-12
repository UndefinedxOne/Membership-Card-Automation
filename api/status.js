/**
 * GET /api/status
 * 
 * Returns server config status and stats.
 */
const { getConfig, getLogs } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const cfg = getConfig();
  const logs = await getLogs();

  return res.status(200).json({
    status: 'running',
    platform: 'vercel-serverless',
    config: {
      acuityConfigured: !!(cfg.ACUITY_USER_ID && cfg.ACUITY_API_KEY),
      passKitConfigured: !!(cfg.PASSKIT_API_KEY && cfg.PASSKIT_API_SECRET),
      programId: cfg.PASSKIT_PROGRAM_ID ? '✓ Set' : '✗ Missing',
      tierId: cfg.PASSKIT_TIER_ID ? '✓ Set' : '✗ Missing',
      membershipFilter: cfg.MEMBERSHIP_PRODUCT_FILTER || '(none — all orders processed)',
    },
    webhookUrl: '/webhook/acuity',
    totalProcessed: logs.filter(l => l.message && l.message.includes('Successfully created')).length,
    totalErrors: logs.filter(l => l.level === 'error').length,
    kvAvailable: logs.length > 0 || !!process.env.KV_REST_API_URL,
  });
};
