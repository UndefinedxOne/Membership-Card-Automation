/**
 * POST /api/webhook
 * 
 * Receives Acuity Scheduling "order.completed" webhooks.
 * Acuity sends application/x-www-form-urlencoded POST with: action, id, calendarID, appointmentTypeID
 * 
 * Rewritten from: /webhook/acuity (handled via vercel.json rewrite)
 */
const { verifyAcuitySignature, appendLog, processNewMembershipOrder } = require('../lib/helpers');
const querystring = require('querystring');

// Vercel serverless functions need raw body for signature verification.
// We disable the default body parser and handle it manually.
module.exports.config = {
  api: {
    bodyParser: false,
  },
};

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  // Only accept POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch {
    return res.status(400).json({ error: 'Could not read request body' });
  }

  // Parse the URL-encoded body
  const body = querystring.parse(rawBody);

  await appendLog('info', 'Received Acuity webhook', {
    action: body.action,
    id: body.id,
  });

  // Verify signature (if present)
  const signature = req.headers['x-acuity-signature'];
  if (signature && !verifyAcuitySignature(rawBody, signature)) {
    await appendLog('error', 'Invalid Acuity webhook signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // Only process order.completed events
  if (body.action !== 'order.completed') {
    await appendLog('info', `Ignoring webhook action: ${body.action}`);
    return res.status(200).json({ status: 'ignored', action: body.action });
  }

  const orderId = body.id;
  if (!orderId) {
    await appendLog('error', 'No order ID in webhook payload');
    return res.status(400).json({ error: 'Missing order ID' });
  }

  // In serverless, we must complete processing BEFORE responding,
  // because the function terminates after the response is sent.
  try {
    const result = await processNewMembershipOrder(orderId);
    return res.status(200).json({ status: 'ok', orderId, result });
  } catch (err) {
    await appendLog('error', `Error processing order #${orderId}`, err.message);
    // Return 200 so Acuity doesn't retry (we logged the error).
    // Return 500 if you WANT Acuity to retry on failure.
    return res.status(200).json({ status: 'error', orderId, error: err.message });
  }
};
