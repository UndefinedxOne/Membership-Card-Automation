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
    PASSKIT_TIER_ID: process.env.PASSKIT_TIER_ID,
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

// ---------- ACTIVITY LOG (Vercel KV or in-memory fallback) ----------
// Vercel KV is optional — if not configured, logs are ephemeral per invocation
// but still written to Vercel's function logs (visible in dashboard).

const LOG_KV_KEY = 'acuity_passkit_logs';
const MAX_LOG_ENTRIES = 100;

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

  // Try Vercel KV if available
  try {
    const kv = getKV();
    if (kv) {
      let logs = [];
      try {
        logs = (await kv.get(LOG_KV_KEY)) || [];
      } catch { logs = []; }
      logs.unshift(entry);
      if (logs.length > MAX_LOG_ENTRIES) logs = logs.slice(0, MAX_LOG_ENTRIES);
      await kv.set(LOG_KV_KEY, logs);
    }
  } catch {
    // KV not available — that's okay, logs are in stdout
  }

  return entry;
}

async function getLogs() {
  try {
    const kv = getKV();
    if (kv) {
      return (await kv.get(LOG_KV_KEY)) || [];
    }
  } catch {}
  return [];
}

function getKV() {
  // Vercel KV auto-injects via @vercel/kv
  // If the user has Vercel KV linked, this works.
  // Otherwise returns null and we degrade gracefully.
  try {
    const { kv } = require('@vercel/kv');
    return kv;
  } catch {
    return null;
  }
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

  // Step 3: Build PassKit member record
  const memberData = {
    programId: cfg.PASSKIT_PROGRAM_ID,
    tierId: cfg.PASSKIT_TIER_ID,
    externalId: order.email,
    person: {
      forename: order.firstName || '',
      surname: order.lastName || '',
      emailAddress: order.email || '',
      displayName: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
    },
    metaData: {
      acuityOrderId: String(orderId),
      membershipType: order.title || '',
      signupDate: new Date().toISOString(),
    },
  };

  if (order.phone) {
    memberData.person.mobileNumber = order.phone;
  }

  await appendLog('info', `Creating PassKit member for ${memberData.person.displayName}...`, {
    email: memberData.person.emailAddress,
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
