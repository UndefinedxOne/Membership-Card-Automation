/**
 * Shared helpers for Acuity and PassKit API calls.
 * Used by all serverless functions.
 */
const crypto = require('crypto');
const axios = require('axios');
const jwt = require('jsonwebtoken');

// ---------- CONFIG (from Vercel Environment Variables) ----------
function getConfig() {
  return {
    ACUITY_USER_ID: process.env.ACUITY_USER_ID,
    ACUITY_API_KEY: process.env.ACUITY_API_KEY,
    PASSKIT_API_KEY: process.env.PASSKIT_API_KEY,
    PASSKIT_API_SECRET: process.env.PASSKIT_API_SECRET,
    PASSKIT_API_URL: process.env.PASSKIT_API_URL || 'https://api.pub1.passkit.io',
    PASSKIT_PROGRAM_ID: process.env.PASSKIT_PROGRAM_ID,
    MEMBERSHIP_PRODUCT_FILTER: process.env.MEMBERSHIP_PRODUCT_FILTER || '',
  };
}

// ---------- PASSKIT JWT ----------
function generatePassKitJWT(apiKey, apiSecret) {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { uid: apiKey, iat: now, exp: now + 3600 },
    apiSecret,
    { algorithm: 'HS256' }
  );
}

// ---------- PASSKIT REQUEST ----------
async function passKitRequest(method, endpoint, data = null) {
  const cfg = getConfig();
  const token = generatePassKitJWT(cfg.PASSKIT_API_KEY, cfg.PASSKIT_API_SECRET);
  const config = {
    method,
    url: `${cfg.PASSKIT_API_URL}${endpoint}`,
    headers: {
      Authorization: token,
      'Content-Type': 'application/json',
    },
  };
  if (data) config.data = data;
  return axios(config);
}

// ---------- ACUITY REQUEST ----------
function createAcuityClient() {
  const cfg = getConfig();
  return axios.create({
    baseURL: 'https://acuityscheduling.com/api/v1',
    auth: {
      username: cfg.ACUITY_USER_ID,
      password: cfg.ACUITY_API_KEY,
    },
  });
}

// ---------- VERIFY ACUITY SIGNATURE ----------
function verifyAcuitySignature(rawBody, signature) {
  const cfg = getConfig();
  if (!cfg.ACUITY_API_KEY || !signature) return false;
  const hash = crypto
    .createHmac('sha256', cfg.ACUITY_API_KEY)
    .update(rawBody)
    .digest('base64');
  return hash === signature;
}

// ---------- ACTIVITY LOG (Upstash Redis or in-memory fallback) ----------
// Redis is optional — if not configured, logs are ephemeral per invocation
// but still written to Vercel's function logs (visible in dashboard).

const LOG_REDIS_KEY = 'acuity_passkit_logs';
const MAX_LOG_ENTRIES = 100;
let redisClient;

async function appendLog(level, message, data = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    data,
  };

  // Always log to stdout (visible in Vercel Functions logs)
  console[level === 'error' ? 'error' : 'log'](
    `[${entry.timestamp}] [${level.toUpperCase()}] ${message}`,
    data ? JSON.stringify(data) : ''
  );

  // Try Upstash Redis if available
  try {
    const redis = getRedis();
    if (redis) {
      await redis.lpush(LOG_REDIS_KEY, JSON.stringify(entry));
      await redis.ltrim(LOG_REDIS_KEY, 0, MAX_LOG_ENTRIES - 1);
    }
  } catch {
    // Redis not available — that's okay, logs are in stdout
  }

  return entry;
}

async function getLogs() {
  try {
    const redis = getRedis();
    if (redis) {
      const rows = (await redis.lrange(LOG_REDIS_KEY, 0, MAX_LOG_ENTRIES - 1)) || [];
      return rows
        .map((row) => {
          if (!row) return null;
          if (typeof row === 'string') {
            try { return JSON.parse(row); } catch { return null; }
          }
          return row;
        })
        .filter(Boolean);
    }
  } catch {}
  return [];
}

function getRedis() {
  // Supports native Upstash env vars and legacy Vercel KV aliases.
  if (redisClient !== undefined) return redisClient;

  try {
    const { Redis } = require('@upstash/redis');
    const creds = getRedisCredentials();
    const url = creds?.url;
    const token = creds?.token;
    if (!url || !token) {
      redisClient = null;
      return redisClient;
    }
    redisClient = new Redis({ url, token });
    return redisClient;
  } catch {
    redisClient = null;
    return redisClient;
  }
}

function getRedisCredentials() {
  const explicitUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const explicitToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (explicitUrl && explicitToken) {
    return { url: explicitUrl, token: explicitToken };
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;

  // Upstash Vercel integrations may expose REDIS_URL in redis:// format.
  // Derive REST credentials for @upstash/redis when explicit REST vars are missing.
  try {
    const parsed = new URL(redisUrl);
    const host = parsed.hostname || '';
    const token = decodeURIComponent(parsed.password || '');
    const isUpstashHost = host.endsWith('upstash.io');
    if (!isUpstashHost || !token) return null;
    return { url: `https://${host}`, token };
  } catch {
    return null;
  }
}

function isCertificateCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{8}$/.test(value.trim());
}

function extractCertificateCode(order) {
  const directCandidates = [
    order?.certificateCode,
    order?.certificate_code,
    order?.certificate,
    order?.giftCertificateCode,
    order?.gift_certificate_code,
    order?.giftCertificate,
    order?.certificate?.code,
    order?.giftCertificate?.code,
  ];

  for (const candidate of directCandidates) {
    if (isCertificateCode(candidate)) return candidate.trim();
  }

  // Fallback: inspect nested objects for certificate-like keys.
  const stack = [order];
  while (stack.length) {
    const current = stack.pop();
    if (!current || typeof current !== 'object') continue;
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') {
        const keyLooksRelevant = /certificate|gift/i.test(key);
        if (keyLooksRelevant && isCertificateCode(value)) return value.trim();
      } else if (value && typeof value === 'object') {
        stack.push(value);
      }
    }
  }

  return null;
}

// ---------- CORE: PROCESS ORDER ----------
async function processNewMembershipOrder(orderId) {
  const cfg = getConfig();
  await appendLog('info', `Processing order #${orderId}...`);

  // Step 1: Fetch order details from Acuity
  const acuity = createAcuityClient();
  let order;
  try {
    const response = await acuity.get(`/orders/${orderId}`);
    order = response.data;
    await appendLog('info', `Fetched order #${orderId} from Acuity`, {
      name: `${order.firstName} ${order.lastName}`,
      email: order.email,
      title: order.title,
    });
  } catch (err) {
    await appendLog('error', `Failed to fetch order #${orderId} from Acuity`, err.message);
    throw err;
  }

  // Step 2: Check membership product filter
  const filterProducts = cfg.MEMBERSHIP_PRODUCT_FILTER
    ? cfg.MEMBERSHIP_PRODUCT_FILTER.split(',').map(p => p.trim().toLowerCase())
    : [];

  if (filterProducts.length > 0) {
    const orderTitle = (order.title || '').toLowerCase();
    const isMatch = filterProducts.some(p => orderTitle.includes(p));
    if (!isMatch) {
      await appendLog('info', `Order #${orderId} doesn't match filter. Skipping.`, {
        orderTitle: order.title,
        filter: cfg.MEMBERSHIP_PRODUCT_FILTER,
      });
      return { skipped: true, reason: 'Product filter mismatch' };
    }
  }

  const certificateCode = extractCertificateCode(order);
  if (!certificateCode) {
    await appendLog('error', `Order #${orderId} is missing a valid certificate code`, {
      expectedFormat: '8 alphanumeric characters',
    });
    throw new Error('Missing or invalid Acuity certificate code (expected 8 alphanumeric characters)');
  }

  // Step 3: Build PassKit member record
  const memberData = {
    programId: cfg.PASSKIT_PROGRAM_ID,
    tierId: 'membership',
    externalId: certificateCode,
    person: {
      forename: order.firstName || '',
      surname: order.lastName || '',
      emailAddress: order.email || '',
      displayName: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
    },
    metaData: {
      acuityOrderId: String(orderId),
      certificateCode,
      membershipType: order.title || '',
      signupDate: new Date().toISOString(),
    },
  };

  if (order.phone) {
    memberData.person.mobileNumber = order.phone;
  }

  await appendLog('info', `Creating PassKit member for ${memberData.person.displayName}...`, {
    email: memberData.person.emailAddress,
    externalId: memberData.externalId,
    membership: memberData.metaData.membershipType,
  });

  // Step 4: Enrol in PassKit
  try {
    const response = await passKitRequest('PUT', '/members/member', memberData);
    await appendLog('info', `Successfully created PassKit member!`, {
      passKitId: response.data?.id || response.data,
      name: memberData.person.displayName,
      email: memberData.person.emailAddress,
    });
    return {
      success: true,
      passKitId: response.data?.id || response.data,
      member: memberData.person.displayName,
    };
  } catch (err) {
    const errorDetail = err.response?.data || err.message;
    await appendLog('error', `Failed to create PassKit member`, errorDetail);
    throw err;
  }
}

module.exports = {
  getConfig,
  generatePassKitJWT,
  passKitRequest,
  createAcuityClient,
  verifyAcuitySignature,
  appendLog,
  getLogs,
  processNewMembershipOrder,
};
