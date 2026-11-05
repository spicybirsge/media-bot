import { readFileSync } from 'node:fs';
import os from 'node:os';

import {
  EmbedBuilder,
  SlashCommandBuilder,
  escapeMarkdown,
  version as discordJsVersion,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { describeError } from '../lib/errors.js';
import { formatBytes, formatDuration, progressBar } from '../lib/format.js';
import { logger } from '../logger.js';

const CPU_SAMPLE_MS = 200;

interface CpuTotals {
  readonly total: number;
  readonly idle: number;
}

function readCpuTotals(): CpuTotals {
  let total = 0;
  let idle = 0;

  for (const cpu of os.cpus()) {
    const times = cpu.times;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }

  return { total, idle };
}

/** Short two-sample average so the number is instantaneous rather than since boot. */
async function sampleCpuPercent(sampleMs = CPU_SAMPLE_MS): Promise<number> {
  const start = readCpuTotals();
  await new Promise((resolve) => setTimeout(resolve, sampleMs));
  const end = readCpuTotals();

  const total = end.total - start.total;
  const idle = end.idle - start.idle;

  if (total <= 0) return 0;

  return Math.min(100, Math.max(0, (1 - idle / total) * 100));
}

function osLabel(): string {
  const arch = os.arch();

  switch (os.platform()) {
    case 'win32':
      return `Windows ${os.release()} · ${arch}`;
    case 'darwin':
      return `macOS ${os.release()} · ${arch}`;
    default:
      return `${os.type()} ${os.release()} · ${arch}`;
  }
}

/**
 * On Linux `os.freemem()` is MemFree, which ignores reclaimable cache and makes
 * a healthy box look 90% full. Prefer MemAvailable when it exists.
 */
function availableMemory(): number {
  if (process.platform === 'linux') {
    try {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const match = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(meminfo);

      if (match?.[1]) return Number(match[1]) * 1024;
    } catch {
      // Fall back to the portable call below.
    }
  }

  return os.freemem();
}

function colorForLoad(percent: number): number {
  if (percent >= 85) return 0xe74c3c;
  if (percent >= 60) return 0xf1c40f;

  return 0x2ecc71;
}

export const statsCommand = {
  data: new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Show bot and host system statistics'),

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply();
    } catch (error) {
      logger.warn('Failed to defer /stats.', describeError(error));
      return;
    }

    try {
      const cpu = await sampleCpuPercent();
      const memory = process.memoryUsage();
      const totalMemory = os.totalmem();
      const available = availableMemory();
      const usedMemory = Math.max(0, totalMemory - available);
      const memoryPercent = totalMemory > 0 ? (usedMemory / totalMemory) * 100 : 0;

      const cpus = os.cpus();
      const threads = cpus.length;
      const cpuModel = (cpus[0]?.model ?? 'Unknown CPU').replace(/\s+/g, ' ').trim();
      const avatar = interaction.client.user.displayAvatarURL({ size: 128 });
      const ping = interaction.client.ws.ping;
      const applicationName =
        interaction.client.application?.name ?? interaction.client.user.username;

      const embed = new EmbedBuilder()
        .setColor(colorForLoad(Math.max(cpu, memoryPercent)))
        .setTitle('📊 System Statistics')
        .setDescription(
          `Live snapshot of the machine running **${escapeMarkdown(applicationName)}**.`,
        )
        .addFields(
          { name: '⏱️ Bot uptime', value: `\`${formatDuration(process.uptime())}\`` },
          { name: '🕒 Host uptime', value: `\`${formatDuration(os.uptime())}\`` },
          { name: '📡 Gateway ping', value: `\`${ping} ms\`` },
          { name: '⚡ CPU load', value: `${progressBar(cpu)} \`${cpu.toFixed(1)}%\`` },
          {
            name: '🧩 CPU',
            value: `\`${threads} thread${threads === 1 ? '' : 's'}\`\n${cpuModel}`,
          },
          {
            name: '🧠 Process RAM',
            value: `RSS \`${formatBytes(memory.rss)}\`\nHeap \`${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}\``,
          },
          {
            name: '🖥️ System RAM',
            value: `${progressBar(memoryPercent)} \`${formatBytes(usedMemory)} / ${formatBytes(totalMemory)}\``,
          },
          { name: '💻 OS', value: `\`${osLabel()}\`` },
          {
            name: '🟢 Runtime',
            value: `Node \`${process.version}\`\ndiscord.js \`v${discordJsVersion}\``,
          },
        )
        .setFooter({ text: `Running on ${os.hostname()}`, iconURL: avatar })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
    } catch (error) {
      const reason = describeError(error);
      logger.error('/stats failed.', reason);

      await interaction
        .editReply({ content: `stats failed: ${reason}`, allowedMentions: { parse: [] } })
        .catch((replyError: unknown) => {
          logger.warn('Failed to report /stats failure.', describeError(replyError));
        });
    }
  },
};
