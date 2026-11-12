// Set fake values before importing config; never use .env credentials in tests.
Object.assign(process.env, {
  DISCORD_TOKEN: 'test-token',
  DISCORD_CHANNEL_ID: '100000000000000001',
  DISCORD_SOCIAL_ID: '100000000000000002',
  DISCORD_GUILD_ID: '',
  OWNER_ID: '100000000000000003',
  R2_ACCOUNT_ID: 'test-account',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
  R2_BUCKET: 'test-bucket',
  R2_PUBLIC_BASE_URL: 'https://archive.example.com',
});
