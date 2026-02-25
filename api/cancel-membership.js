/**
 * POST /api/cancel-membership?orderId=123
 * POST /api/cancel-membership?certificateCode=AB12CD34
 *
 * Deactivates a member in PassKit and removes certificate->order mapping.
 */
const helpers = require('../lib/helpers');

function looksLikeCertificateCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{8}$/.test(value.trim());
}

function getCancelByCodeFn() {
  return (
    helpers.cancelMembershipByCertificateCode ||
    helpers.cancelMembershipByCertificatecode ||
    null
  );
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawOrderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
  const rawCertificateCode = typeof req.query.certificateCode === 'string'
    ? req.query.certificateCode.trim()
    : '';

  const cancelByCodeFn = getCancelByCodeFn();
  const processCancellationFn = helpers.processMembershipCancellation;
  const resolveOrderIdFn = helpers.resolveOrderIdByCertificateCode;

  try {
    if (rawCertificateCode || looksLikeCertificateCode(rawOrderId)) {
      const certificateCode = (rawCertificateCode || rawOrderId).toUpperCase();
      let result;

      if (typeof cancelByCodeFn === 'function') {
        result = await cancelByCodeFn(certificateCode, {
          sourceAction: 'manual.cancel',
          reason: 'Manual cancellation request',
        });
      } else if (typeof resolveOrderIdFn === 'function' && typeof processCancellationFn === 'function') {
        const resolvedOrderId = await resolveOrderIdFn(certificateCode);
        if (!resolvedOrderId) {
          return res.status(404).json({
            error: 'Cancellation helper unavailable and no certificate mapping found for this code.',
          });
        }
        result = await processCancellationFn(resolvedOrderId, {
          sourceAction: 'manual.cancel',
          reason: 'Manual cancellation request',
        });
      } else {
        return res.status(500).json({
          error: 'Cancellation helpers are unavailable in this deployment. Redeploy latest code.',
        });
      }

      return res.status(200).json({ status: 'ok', result });
    }

    if (rawOrderId) {
      if (typeof processCancellationFn !== 'function') {
        return res.status(500).json({
          error: 'Order cancellation helper unavailable in this deployment. Redeploy latest code.',
        });
      }

      const result = await processCancellationFn(rawOrderId, {
        sourceAction: 'manual.cancel',
        reason: 'Manual cancellation request',
      });
      return res.status(200).json({ status: 'ok', orderId: rawOrderId, result });
    }

    return res.status(400).json({ error: 'Missing orderId or certificateCode query parameter' });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
