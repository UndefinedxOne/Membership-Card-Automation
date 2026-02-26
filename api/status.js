/**
 * GET /api/status
 *
 * Returns server config status and stats.
 */

function getErrorMessage(err, fallback) {
  if (err && typeof err.message === 'string' && err.message) return err.message;
  return fallback;
}

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

  const envConfig = {
    acuityConfigured: !!(process.env.ACUITY_USER_ID && process.env.ACUITY_API_KEY),
    passKitConfigured: !!(process.env.PASSKIT_API_KEY && process.env.PASSKIT_API_SECRET),
    programId: process.env.PASSKIT_PROGRAM_ID ? '✓ Set' : '✗ Missing',
    tierId: '✓ Fixed: membership',
    membershipFilter: process.env.MEMBERSHIP_PRODUCT_FILTER || '(none — all orders processed)',
  };

  let helpers = null;
  try {
    helpers = require('../lib/helpers');
  } catch (err) {
    return res.status(200).json({
      status: 'degraded',
      platform: 'vercel-serverless',
      error: `helpers_load_failed: ${getErrorMessage(err, 'Unknown helper load error')}`,
      config: envConfig,
      webhookUrl: '/webhook/acuity',
      webhookEnabled: true,
      webhookToggleAvailable: false,
      webhookTogglePersistent: false,
      redisConfigured: false,
      redisProvider: null,
      redisError: getErrorMessage(err, 'Unknown helper load error'),
      totalProcessed: 0,
      totalErrors: 0,
      redisAvailable: false,
      kvAvailable: false,
    });
  }

  try {
    const getConfig = typeof helpers.getConfig === 'function' ? helpers.getConfig : null;
    const getLogs = typeof helpers.getLogs === 'function' ? helpers.getLogs : null;
    const getWebhookEnabled = typeof helpers.getWebhookEnabled === 'function' ? helpers.getWebhookEnabled : null;
    const getRedisStatus = typeof helpers.getRedisStatus === 'function' ? helpers.getRedisStatus : null;

    const cfg = getConfig ? getConfig() : {
      ACUITY_USER_ID: process.env.ACUITY_USER_ID,
      ACUITY_API_KEY: process.env.ACUITY_API_KEY,
      PASSKIT_API_KEY: process.env.PASSKIT_API_KEY,
      PASSKIT_API_SECRET: process.env.PASSKIT_API_SECRET,
      PASSKIT_PROGRAM_ID: process.env.PASSKIT_PROGRAM_ID,
      MEMBERSHIP_PRODUCT_FILTER: process.env.MEMBERSHIP_PRODUCT_FILTER || '',
    };

    const fallbackRedisStatus = {
      available: false,
      configured: !!process.env.REDIS_URL,
      provider: null,
      error: 'Redis status helper unavailable',
    };

    const [logs, webhookEnabled, redisStatus] = await Promise.all([
      withTimeout(getLogs ? getLogs() : [], 1500, []),
      withTimeout(getWebhookEnabled ? getWebhookEnabled() : true, 1500, true),
      withTimeout(
        getRedisStatus ? getRedisStatus() : fallbackRedisStatus,
        1500,
        { available: false, configured: !!process.env.REDIS_URL, provider: null, error: 'Redis health check timeout' }
      ),
    ]);

    const redisAvailable = !!(redisStatus && redisStatus.available);

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
      webhookEnabled: webhookEnabled !== false,
      webhookToggleAvailable: true,
      webhookTogglePersistent: redisAvailable,
      redisConfigured: !!(redisStatus && redisStatus.configured),
      redisProvider: (redisStatus && redisStatus.provider) || null,
      redisError: (redisStatus && redisStatus.error) || null,
      totalProcessed: Array.isArray(logs)
        ? logs.filter((l) => l && l.message && String(l.message).includes('Successfully created')).length
        : 0,
      totalErrors: Array.isArray(logs)
        ? logs.filter((l) => l && l.level === 'error').length
        : 0,
      redisAvailable,
      kvAvailable: redisAvailable,
    });
  } catch (err) {
    return res.status(200).json({
      status: 'degraded',
      platform: 'vercel-serverless',
      error: getErrorMessage(err, 'Status check failed'),
      config: envConfig,
      webhookUrl: '/webhook/acuity',
      webhookEnabled: true,
      webhookToggleAvailable: false,
      webhookTogglePersistent: false,
      redisConfigured: !!process.env.REDIS_URL,
      redisProvider: null,
      redisError: getErrorMessage(err, 'Unknown'),
      totalProcessed: 0,
      totalErrors: 0,
      redisAvailable: false,
      kvAvailable: false,
    });
  }
};
