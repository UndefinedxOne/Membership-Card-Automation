/**
 * GET /api/test-acuity
 */
const { createAcuityClient, appendLog } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const acuity = createAcuityClient();
    const response = await acuity.get('/me');
    await appendLog('info', 'Acuity connection test successful');
    return res.status(200).json({ status: 'ok', account: response.data });
  } catch (err) {
    await appendLog('error', 'Acuity connection test failed', err.message);
    return res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
};
