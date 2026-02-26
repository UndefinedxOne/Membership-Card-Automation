/**
 * GET /api/status
 * 
 * Returns server config status and stats.
 */
const { getConfig, getLogs, getWebhookEnabled, getRedisStatus } = require('../lib/helpers');

function withTimeout(promise, ms, fallback) {
  let timer = null;
  return Promise.race([
    Promise.resolve(promise),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(fallback), ms);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const cfg = getConfig();

    const [logs, webhookEnabled, redisStatus] = await Promise.all([
      withTimeout(getLogs(), 1500, []),
      withTimeout(getWebhookEnabled(), 1500, true),
      withTimeout(
        getRedisStatus(),
        1500,
        { available: false, configured: false, provider: null, error: 'Redis health check timeout' }
      ),
    ]);

    const redisAvailable = !!redisStatus.available;

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
      redisConfigured: !!redisStatus.configured,
      redisProvider: redisStatus.provider || null,
      redisError: redisStatus.error || null,
      totalProcessed: Array.isArray(logs)
        ? logs.filter(l => l.message && l.message.includes('Successfully created')).length
        : 0,
      totalErrors: Array.isArray(logs)
        ? logs.filter(l => l.level === 'error').length
        : 0,
      redisAvailable,
      kvAvailable: redisAvailable,
    });
  } catch (err) {
    return res.status(200).json({
      status: 'degraded',
      platform: 'vercel-serverless',
      error: err?.message || 'Status check failed',
      config: {
        acuityConfigured: !!(process.env.ACUITY_USER_ID && process.env.ACUITY_API_KEY),
        passKitConfigured: !!(process.env.PASSKIT_API_KEY && process.env.PASSKIT_API_SECRET),
        programId: process.env.PASSKIT_PROGRAM_ID ? '✓ Set' : '✗ Missing',
        tierId: '✓ Fixed: membership',
        membershipFilter: process.env.MEMBERSHIP_PRODUCT_FILTER || '(none — all orders processed)',
      },
      webhookUrl: '/webhook/acuity',
      webhookEnabled: true,
      webhookToggleAvailable: false,
      webhookTogglePersistent: false,
      redisConfigured: false,
      redisProvider: null,
      redisError: err?.message || 'Unknown',
      totalProcessed: 0,
      totalErrors: 0,
      redisAvailable: false,
      kvAvailable: false,
    });
  }
};
