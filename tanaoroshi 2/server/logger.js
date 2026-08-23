const db = require('./db');

async function logOperation(user, action, target, detail) {
  try {
    await db.run(
      'INSERT INTO operation_logs ("user", action, target, detail) VALUES (?, ?, ?, ?)',
      [user || '不明', action, target || '', typeof detail === 'string' ? detail : JSON.stringify(detail || {})]
    );
  } catch (e) {
    console.error('operation log failed', e);
  }
}

module.exports = { logOperation };
