function setDefault(key: string, value: string) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

setDefault('NODE_ENV', 'test');
setDefault('PORT', '8000');
setDefault('FRONTEND_URL', 'http://localhost:3000');

setDefault('DATABASE_URL', 'postgresql://test:test@localhost:5432/dreamer_test');
setDefault('REDIS_URL', 'redis://localhost:6379/1');

// Secrets must be at least 32 characters
setDefault('JWT_ACCESS_SECRET', 'test-access-secret-please-do-not-use-in-prod');
setDefault('JWT_REFRESH_SECRET', 'test-refresh-secret-please-do-not-use-in-prod');
setDefault('ACCESS_TOKEN_TTL', '15m');
setDefault('REFRESH_TOKEN_TTL_DAYS', '7');

// 64 hex chars for AES-256-GCM encryption key
setDefault('ENCRYPTION_KEY', 'a'.repeat(64));

setDefault('AWS_ACCESS_KEY_ID', 'test-access-key');
setDefault('AWS_SECRET_ACCESS_KEY', 'test-secret-key');
setDefault('S3_ENDPOINT_URL', 'http://localhost:9000');

setDefault('BASE_DOMAIN', 'dreamer.local');
setDefault('DOCKER_BUILD_ENGINE_IMAGE', 'dreamer-build-engine:test');
setDefault('GITHUB_WEBHOOK_SECRET', 'test-webhook-secret-value');

export {};
