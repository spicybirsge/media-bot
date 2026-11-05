import { config } from 'dotenv';

import { Client, GatewayIntentBits } from 'discord.js';

config({ quiet: true });

const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error('Missing DISCORD_TOKEN in environment.');
  process.exit(1);
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once('clientReady', (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
});

client.on('error', (error) => {
  console.error('Discord client error:', error);
});

await client.login(token);
