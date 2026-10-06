import pino from 'pino';
export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: { paths: ['password', '*.password', 'newPassword', 'recoveryCode', 'token', 'req.headers.cookie', 'req.headers.authorization'], censor: '[redacted]' },
});
