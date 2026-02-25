/**
 * GET /api/test-passkit
 */
const { passKitRequest, appendLog } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const response = await passKitRequest('GET', '/user/profile');
    await appendLog('info', 'PassKit connection test successful');
    return res.status(200).json({ status: 'ok', profile: response.data });
  } catch (err) {
    await appendLog('error', 'PassKit connection test failed', err.message);
    return res.status(500).json({ status: 'error', message: err.response?.data || err.message });
  }
};
