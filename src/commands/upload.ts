import {
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

import { archiveAttachment, archiveLink, type ArchiveSuccess } from '../archive.js';
import { config } from '../config.js';
import { describeError } from '../lib/errors.js';
import { logger } from '../logger.js';

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

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
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

    const job: () => Promise<ArchiveSuccess> = file
      ? () => archiveAttachment(file)
      : () => archiveLink(url);

    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    } catch (error) {
      logger.warn('Failed to defer /upload.', describeError(error));
      return;
    }

    try {
      const result = await job();
      await interaction.editReply({ content: result.url, allowedMentions: { parse: [] } });
    } catch (error) {
      const reason = describeError(error);
      logger.error('/upload failed.', reason);

      await interaction
        .editReply({ content: `upload failed: ${reason}`, allowedMentions: { parse: [] } })
        .catch((replyError: unknown) => {
          logger.warn('Failed to report /upload failure.', describeError(replyError));
        });
    }
  },
};
