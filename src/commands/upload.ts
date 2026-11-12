import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { archiveAttachment, archiveLink, type ArchiveSuccess } from '../archive.js';
import { config, SLASH_UPLOAD_TIMEOUT_MS } from '../config.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../logger.js';

interface UploadDependencies {
  readonly archiveAttachment: typeof archiveAttachment;
  readonly archiveLink: typeof archiveLink;
  readonly timeoutMs: number;
}

const defaultDependencies: UploadDependencies = { archiveAttachment, archiveLink, timeoutMs: SLASH_UPLOAD_TIMEOUT_MS };

async function replyEphemeral(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
  try {
    await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  } catch (error) {
    logger.warn('Failed to reply to /upload.', describeError(error));
  }
}

export const uploadCommand = {
  data: new SlashCommandBuilder()
    .setName('upload')
    .setDescription('Archive one file or link into R2')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addAttachmentOption((option) =>
      option.setName('file').setDescription('Attachment to archive'),
    )
    .addStringOption((option) =>
      option
        .setName('url')
        .setDescription('http(s) link to archive')
        .setMaxLength(2000),
    ),

  async execute(interaction: ChatInputCommandInteraction, deps: UploadDependencies = defaultDependencies): Promise<void> {
    if (interaction.user.id !== config.ownerId) {
      await replyEphemeral(interaction, 'Not authorized.');
      return;
    }

    const file = interaction.options.getAttachment('file');
    const url = interaction.options.getString('url')?.trim() ?? '';

    if (file && url) {
      await replyEphemeral(interaction, 'Provide exactly one of `file` or `url`.');
      return;
    }

    if (!file && !url) {
      await replyEphemeral(interaction, 'Provide one of `file` or `url`.');
      return;
    }

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.warn('Failed to defer /upload.', describeError(error));
      return;
    }

    // Include queue wait, download and upload in one deadline, leaving room to
    // reply before the original interaction token expires at 15 minutes.
    const elapsed = Math.max(0, Date.now() - interaction.createdTimestamp);
    const signal = AbortSignal.timeout(Math.max(1, deps.timeoutMs - elapsed));
    let result: ArchiveSuccess;
    try {
      result = file ? await deps.archiveAttachment(file, signal) : await deps.archiveLink(url, signal);
    } catch (error) {
      const reason = signal.aborted
        ? '/upload timed out. Use the archive channel for files that need longer to download or upload.'
        : describeError(error);
      logger.error('/upload failed.', reason);

      await interaction
        .editReply({ content: `upload failed: ${reason}`, allowedMentions: { parse: [] } })
        .catch((replyError: unknown) => {
          logger.warn('Failed to report /upload failure.', describeError(replyError));
        });
      return;
    }

    try {
      await interaction.editReply({ content: result.url, allowedMentions: { parse: [] } });
    } catch (error) {
      logger.error('Could not deliver the /upload result.', { url: result.url, error });
    }
  },
};
