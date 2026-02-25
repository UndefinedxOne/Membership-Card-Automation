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
const CERT_TO_ORDER_KEY_PREFIX = 'acuity_cert_to_order:';
const CERT_TO_ORDER_TTL_SECONDS = 60 * 60 * 24 * 90; // 90 days
const WEBHOOK_ENABLED_KEY = 'acuity_webhook_enabled';
const INACTIVE_ORDER_STATUS = new Set([
  'cancelled',
  'canceled',
  'expired',
  'inactive',
  'voided',
  'refunded',
  'failed',
]);
let redisClient;
let inMemoryWebhookEnabled = null;

function parseBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'enabled'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'disabled'].includes(normalized)) return false;
  }
  return fallback;
}

function getWebhookDefaultEnabled() {
  return parseBoolean(process.env.WEBHOOK_ENABLED_DEFAULT, true);
}

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

async function getWebhookEnabled() {
  const fallback = getWebhookDefaultEnabled();

  if (typeof inMemoryWebhookEnabled === 'boolean') {
    return inMemoryWebhookEnabled;
  }

  try {
    const redis = getRedis();
    if (!redis) return fallback;
    const stored = await redis.get(WEBHOOK_ENABLED_KEY);
    if (stored === null || stored === undefined || stored === '') return fallback;
    return parseBoolean(stored, fallback);
  } catch {
    return fallback;
  }
}

async function setWebhookEnabled(enabled) {
  const nextValue = !!enabled;
  const redis = getRedis();

  if (redis) {
    await redis.set(WEBHOOK_ENABLED_KEY, nextValue ? 'true' : 'false');
    inMemoryWebhookEnabled = nextValue;
    await appendLog('info', `Webhook processing ${nextValue ? 'enabled' : 'disabled'} by operator`, {
      state: nextValue ? 'enabled' : 'disabled',
      persistence: 'redis',
    });
    return nextValue;
  }

  inMemoryWebhookEnabled = nextValue;
  await appendLog('warn', `Webhook processing ${nextValue ? 'enabled' : 'disabled'} (in-memory only)`, {
    state: nextValue ? 'enabled' : 'disabled',
    persistence: 'in-memory',
  });
  return nextValue;
}

function isRedisAvailable() {
  return !!getRedis();
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
  const explicitUrl = process.env.UPSTASH_REDIS_REST_URL
    || process.env.KV_REST_API_URL
    || process.env.REDIS_REST_URL;
  const explicitToken = process.env.UPSTASH_REDIS_REST_TOKEN
    || process.env.KV_REST_API_TOKEN
    || process.env.REDIS_REST_TOKEN;
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
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');
    const token = password || (username && username !== 'default' ? username : '');
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

function normalizeCertificateCode(value) {
  return String(value || '').trim().toUpperCase();
}

async function storeCertificateOrderMapping(certificateCode, orderId) {
  try {
    const redis = getRedis();
    if (!redis) return;

    const code = normalizeCertificateCode(certificateCode);
    if (!isCertificateCode(code)) return;

    await redis.set(`${CERT_TO_ORDER_KEY_PREFIX}${code}`, String(orderId), {
      ex: CERT_TO_ORDER_TTL_SECONDS,
    });
  } catch {
    // Mapping is a convenience feature; failures should not block enrollment.
  }
}

async function resolveOrderIdByCertificateCode(certificateCode) {
  const code = normalizeCertificateCode(certificateCode);
  if (!isCertificateCode(code)) return null;

  try {
    const redis = getRedis();
    if (!redis) return null;
    const orderId = await redis.get(`${CERT_TO_ORDER_KEY_PREFIX}${code}`);
    if (!orderId) return null;
    return String(orderId);
  } catch {
    return null;
  }
}

async function removeCertificateOrderMapping(certificateCode) {
  try {
    const redis = getRedis();
    if (!redis) return;

    const code = normalizeCertificateCode(certificateCode);
    if (!isCertificateCode(code)) return;
    await redis.del(`${CERT_TO_ORDER_KEY_PREFIX}${code}`);
  } catch {
    // Mapping removal is best-effort.
  }
}

function isTruthyFlag(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value === 1;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }
  return false;
}

function evaluateOrderActivity(order) {
  const cancellationFlags = ['cancelled', 'canceled', 'isCancelled', 'isCanceled'];
  for (const flag of cancellationFlags) {
    if (isTruthyFlag(order?.[flag])) {
      return { active: false, reason: `Acuity order flag ${flag}=true` };
    }
  }

  if (order?.active === false || order?.isActive === false) {
    return { active: false, reason: 'Acuity order marked inactive' };
  }

  const statusFields = [
    order?.status,
    order?.orderStatus,
    order?.subscriptionStatus,
    order?.membershipStatus,
  ];

  for (const value of statusFields) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (!normalized) continue;
    if (INACTIVE_ORDER_STATUS.has(normalized) || normalized.includes('cancel') || normalized.includes('expire')) {
      return { active: false, reason: `Acuity status indicates inactive: ${value}` };
    }
  }

  return { active: true };
}

async function findPassKitMemberByExternalId(externalId) {
  const cfg = getConfig();
  if (!cfg.PASSKIT_PROGRAM_ID) {
    throw new Error('Missing PASSKIT_PROGRAM_ID for PassKit member lookup');
  }

  function toMemberRef(candidate) {
    if (!candidate || typeof candidate !== 'object') return null;
    const id = candidate.id || candidate.memberId || null;
    if (!id) return null;
    return {
      id: String(id),
      emailAddress: candidate?.person?.emailAddress || candidate?.emailAddress || null,
      externalId: candidate?.externalId || null,
    };
  }

  async function parseMemberRefFromPayload(data) {
    if (!data) return null;

    const direct = toMemberRef(data);
    if (direct) return direct;

    const nestedCandidates = [
      data.member,
      data.item,
      data.result,
      data.data && !Array.isArray(data.data) ? data.data : null,
    ].filter(Boolean);

    for (const nested of nestedCandidates) {
      const nestedRef = toMemberRef(nested);
      if (nestedRef) return nestedRef;
    }

    const directMemberIds = Array.isArray(data.memberIds) ? data.memberIds : null;
    if (directMemberIds && directMemberIds.length > 0) {
      return { id: String(directMemberIds[0]), emailAddress: null, externalId: null };
    }

    const listCandidates = [
      Array.isArray(data) ? data : null,
      Array.isArray(data.members) ? data.members : null,
      Array.isArray(data.results) ? data.results : null,
      Array.isArray(data.items) ? data.items : null,
      Array.isArray(data.data) ? data.data : null,
    ].filter(Boolean);

    for (const rows of listCandidates) {
      if (!rows.length) continue;
      const first = rows[0];
      if (typeof first === 'string') {
        return { id: first, emailAddress: null, externalId: null };
      }
      const rowRef = toMemberRef(first);
      if (rowRef) return rowRef;
    }

    return null;
  }

  async function queryMemberByField(filterField, filterValue) {
    const payload = {
      filters: {
        limit: 1,
        offset: 0,
        orderBy: 'updated',
        orderAsc: false,
        filterGroups: [{
          condition: 'AND',
          fieldFilters: [{
            filterField,
            filterValue,
            filterOperator: 'eq',
          }],
        }],
      },
    };

    const response = await passKitRequest('POST', `/members/member/list/${cfg.PASSKIT_PROGRAM_ID}`, payload);
    return parseMemberRefFromPayload(response?.data);
  }

  // PassKit exposes a direct lookup by externalId; use it first for reliability.
  try {
    const direct = await passKitRequest(
      'GET',
      `/members/member/externalId/${cfg.PASSKIT_PROGRAM_ID}/${encodeURIComponent(externalId)}`
    );
    const byDirectLookup = await parseMemberRefFromPayload(direct?.data);
    if (byDirectLookup) return byDirectLookup;
  } catch {
    // Continue with filter-based fallbacks.
  }

  // Fallback lookups by filter field.
  try {
    const byMemberId = await queryMemberByField('memberId', externalId);
    if (byMemberId) return byMemberId;
  } catch {
    // Continue with fallback lookup.
  }

  try {
    const byExternalId = await queryMemberByField('externalId', externalId);
    if (byExternalId) return byExternalId;
  } catch {
    // Fall through to null.
  }

  return null;
}

async function deactivatePassKitMembershipByExternalId(externalId, context = {}) {
  const cfg = getConfig();
  if (!cfg.PASSKIT_PROGRAM_ID) {
    throw new Error('Missing PASSKIT_PROGRAM_ID for PassKit cancellation');
  }

  const cancellationMeta = {
    cancelledAt: new Date().toISOString(),
    cancellationReason: context.reason || 'Membership cancelled',
    ...(context.orderId ? { acuityOrderId: String(context.orderId) } : {}),
    ...(context.sourceAction ? { acuityAction: context.sourceAction } : {}),
  };

  const member = await findPassKitMemberByExternalId(externalId);
  if (!member?.id) {
    return { success: true, method: 'member_not_found', passKitId: null };
  }

  const cancellationPayload = {
    id: member.id,
    programId: cfg.PASSKIT_PROGRAM_ID,
    externalId,
    status: 'CANCELLED',
    metaData: cancellationMeta,
  };
  if (member.emailAddress) {
    cancellationPayload.person = { emailAddress: member.emailAddress };
  }

  try {
    const response = await passKitRequest('PUT', '/members/member', cancellationPayload);
    return {
      success: true,
      method: 'status_update',
      passKitId: response.data?.id || member.id,
    };
  } catch (statusErr) {
    await appendLog('warn', 'PassKit status update to CANCELLED failed, trying delete fallback', {
      externalId,
      memberId: member.id,
      error: statusErr.response?.data || statusErr.message,
    });

    const response = await passKitRequest('DELETE', '/members/member', { id: member.id });
    return {
      success: true,
      method: 'delete',
      passKitId: response.data?.id || member.id,
    };
  }
}

async function cancelMembershipByCertificateCode(certificateCode, context = {}) {
  const code = normalizeCertificateCode(certificateCode);
  if (!isCertificateCode(code)) {
    throw new Error('Invalid certificate code (expected 8 alphanumeric characters)');
  }

  const deactivation = await deactivatePassKitMembershipByExternalId(code, context);
  await removeCertificateOrderMapping(code);

  await appendLog('info', 'Membership cancellation processed', {
    externalId: code,
    method: deactivation.method,
    passKitId: deactivation.passKitId,
    orderId: context.orderId || null,
  });

  return {
    success: true,
    externalId: code,
    ...deactivation,
  };
}

async function processMembershipCancellation(orderId, context = {}) {
  await appendLog('info', `Processing cancellation for order #${orderId}...`, {
    sourceAction: context.sourceAction || null,
  });

  const acuity = createAcuityClient();
  let order;
  try {
    const response = await acuity.get(`/orders/${orderId}`);
    order = response.data;
    await appendLog('info', `Fetched cancellation order #${orderId} from Acuity`, {
      name: `${order.firstName || ''} ${order.lastName || ''}`.trim(),
      email: order.email || null,
      status: order.status || order.orderStatus || null,
      title: order.title || null,
    });
  } catch (err) {
    await appendLog('error', `Failed to fetch cancellation order #${orderId} from Acuity`, err.message);
    throw err;
  }

  const certificateCode = extractCertificateCode(order);
  if (!certificateCode) {
    await appendLog('warn', `No certificate code found for cancellation order #${orderId}; skipping PassKit update`);
    return { skipped: true, reason: 'No certificate code on order' };
  }

  return cancelMembershipByCertificateCode(certificateCode, {
    orderId,
    sourceAction: context.sourceAction || null,
    reason: context.reason || 'Acuity cancellation event',
  });
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

  const extractedCertificateCode = extractCertificateCode(order);
  if (!extractedCertificateCode) {
    await appendLog('error', `Order #${orderId} is missing a valid certificate code`, {
      expectedFormat: '8 alphanumeric characters',
    });
    throw new Error('Missing or invalid Acuity certificate code (expected 8 alphanumeric characters)');
  }
  const certificateCode = normalizeCertificateCode(extractedCertificateCode);

  const orderActivity = evaluateOrderActivity(order);
  if (!orderActivity.active) {
    await appendLog('warn', `Order #${orderId} appears inactive/cancelled. Running cancellation flow.`, {
      reason: orderActivity.reason,
      certificateCode,
    });

    const cancellationResult = await cancelMembershipByCertificateCode(certificateCode, {
      orderId,
      reason: orderActivity.reason,
      sourceAction: 'order.reprocess',
    });

    return {
      skipped: true,
      reason: orderActivity.reason,
      cancellationResult,
    };
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
    await storeCertificateOrderMapping(certificateCode, orderId);
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
  isRedisAvailable,
  getWebhookEnabled,
  setWebhookEnabled,
  cancelMembershipByCertificateCode,
  // Backward-compatible alias for any stale call sites with typo casing.
  cancelMembershipByCertificatecode: cancelMembershipByCertificateCode,
  processMembershipCancellation,
  resolveOrderIdByCertificateCode,
  processNewMembershipOrder,
};
