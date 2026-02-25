/**
 * POST /api/process-order?orderId=123
 * 
 * Manually (re-)process an Acuity order to create a PassKit member.
 * Useful for testing or re-processing a failed order.
 */
const { processNewMembershipOrder } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const orderId = req.query.orderId;
  if (!orderId) {
    return res.status(400).json({ error: 'Missing orderId query parameter' });
  }

  try {
    const result = await processNewMembershipOrder(orderId);
    return res.status(200).json({ status: 'ok', result });
  } catch (err) {
    return res.status(500).json({ status: 'error', message: err.message });
  }
};
