/**
 * POST /api/cancel-membership?orderId=123
 * POST /api/cancel-membership?certificateCode=AB12CD34
 *
 * Deactivates a member in PassKit and removes certificate->order mapping.
 */
const {
  cancelMembershipByCertificateCode,
  processMembershipCancellation,
} = require('../lib/helpers');

function looksLikeCertificateCode(value) {
  return typeof value === 'string' && /^[A-Za-z0-9]{8}$/.test(value.trim());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawOrderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
  const rawCertificateCode = typeof req.query.certificateCode === 'string'
    ? req.query.certificateCode.trim()
    : '';

  try {
    if (rawCertificateCode || looksLikeCertificateCode(rawOrderId)) {
      const certificateCode = (rawCertificateCode || rawOrderId).toUpperCase();
      const result = await cancelMembershipByCertificateCode(certificateCode, {
        sourceAction: 'manual.cancel',
        reason: 'Manual cancellation request',
      });
      return res.status(200).json({ status: 'ok', result });
    }

    if (rawOrderId) {
      const result = await processMembershipCancellation(rawOrderId, {
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
