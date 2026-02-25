/**
 * GET /api/logs
 * 
 * Returns the activity log. Uses Upstash Redis if available,
 * otherwise returns empty (logs are still in Vercel function logs).
 */
const { getLogs } = require('../lib/helpers');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const logs = await getLogs();
  return res.status(200).json(logs);
};
