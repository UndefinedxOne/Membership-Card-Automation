/**
 * POST /api/process-order?orderId=123
 * POST /api/process-order?certificateCode=AB12CD34
 * 
 * Manually (re-)process an Acuity order to create a PassKit member.
 * Useful for testing or re-processing a failed order.
 */
const { processNewMembershipOrder, resolveOrderIdByCertificateCode } = require('../lib/helpers');

function looksLikeCertificateCode(value) {
  // Avoid treating purely numeric order IDs as certificate codes.
  return typeof value === 'string' && /^(?=.*[A-Za-z])[A-Za-z0-9]{8}$/.test(value.trim());
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawOrderId = typeof req.query.orderId === 'string' ? req.query.orderId.trim() : '';
  const rawCertificateCode = typeof req.query.certificateCode === 'string'
    ? req.query.certificateCode.trim()
    : '';

  let orderId = rawOrderId;
  let resolvedBy = null;

  const certificateCode = rawCertificateCode || (looksLikeCertificateCode(rawOrderId) ? rawOrderId : '');
  if (certificateCode) {
    orderId = await resolveOrderIdByCertificateCode(certificateCode);
    resolvedBy = 'certificateCode';
    if (!orderId) {
      return res.status(404).json({
        error: 'Could not resolve orderId from certificate code yet. Try after the order is processed once via webhook.',
      });
    }
  }

  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId or certificateCode query parameter' });
  }

  try {
    const result = await processNewMembershipOrder(orderId);
    return res.status(200).json({
      status: 'ok',
      orderId,
      ...(resolvedBy ? { resolvedBy } : {}),
      result,
    });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
