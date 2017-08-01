export default {
  HOST: '0.0.0.0',
  PORT: '8000',
  BASE_URL: 'http://localhost:8000',
  WEBPACK_DEV_URL: 'http://localhost:8001',
  NODE_ENV: 'development',
  ENVIRONMENT: 'development',
  UBUNTU_SSO_URL: 'https://login.ubuntu.com',
  OPENID_VERIFY_URL: 'http://localhost:8000/login/verify',
  LP_API_URL: 'https://api.launchpad.net',
  LP_WEBHOOK_SECRET: 'dummy-lp-webhook-secret',
  STORE_API_URL: 'https://dashboard.snapcraft.io/dev/api',
  STORE_DEVPORTAL_URL: 'https://dashboard.snapcraft.io/dev',
  STORE_ALLOWED_CHANNELS: ['edge'],
  STORE_PACKAGE_UPLOAD_REQUEST_LIFETIME: '7200',
  GITHUB_API_ENDPOINT: 'https://api.github.com',
  GITHUB_AUTH_LOGIN_URL: 'https://github.com/login/oauth/authorize',
  GITHUB_AUTH_VERIFY_URL: 'https://github.com/login/oauth/access_token',
  GITHUB_AUTH_REDIRECT_URL: 'http://localhost:8000/auth/verify',
  GITHUB_REPOSITORY_PREFIX: 'https://github.com/',
  GITHUB_WEBHOOK_SECRET: 'dummy-gh-webhook-secret',
  KNEX_CONFIG_PATH: 'knexfile.js'
};
