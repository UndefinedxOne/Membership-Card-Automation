module.exports = async function handler(req, res) {
  return res.status(200).json({
    app: 'acuity-passkit-bridge',
    build: '2026-02-26-status-fallback-v3',
    timestamp: new Date().toISOString(),
  });
};
