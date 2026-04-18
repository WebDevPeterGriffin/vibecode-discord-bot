require("dotenv").config();

const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
  MessageFlags,
} = require("discord.js");
const express = require("express");

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN          = process.env.BOT_TOKEN;
const APPLICATION_ID     = process.env.APPLICATION_ID;
const GUILD_ID           = process.env.GUILD_ID;
const VIBECODE_CHANNEL_ID = process.env.VIBECODE_CHANNEL_ID;
const VIBECODE_API       = (process.env.VIBECODE_API || "https://george420-vibecodebible.hf.space").replace(/\/$/, "");
const PORT               = process.env.PORT || 8080;

// Per-user rate limit: one request per 10 seconds
const RATE_LIMIT_MS = 10_000;
const userCooldowns = new Map(); // userId → timestamp of last request

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns true and sets the cooldown if the user is allowed to make a request.
 * Returns false if still on cooldown.
 */
function checkRateLimit(userId) {
  const now = Date.now();
  const last = userCooldowns.get(userId) ?? 0;
  if (now - last < RATE_LIMIT_MS) return false;
  userCooldowns.set(userId, now);
  return true;
}

/** Remaining cooldown in seconds (rounded up), for error messages. */
function cooldownRemaining(userId) {
  const elapsed = Date.now() - (userCooldowns.get(userId) ?? 0);
  return Math.ceil((RATE_LIMIT_MS - elapsed) / 1000);
}

/** Call the VibeCode API and return the answer string. */
async function askVibeCode(question) {
  const res = await fetch(`${VIBECODE_API}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question }),
  });

  if (!res.ok) {
    throw new Error(`API responded with status ${res.status}`);
  }

  const data = await res.json();
  return data.answer ?? "No answer returned.";
}

/**
 * DM the answer to the user.
 * - interaction: the deferred interaction to editReply on (slash or modal submit)
 * - dmChannel: pass a DM channel directly (raw DM context, no interaction)
 */
async function sendAnswer(user, answer, interaction = null, dmChannel = null) {
  const chunks = splitMessage(answer);

  if (dmChannel) {
    // Raw DM — reply directly in the DM channel
    for (const chunk of chunks) await dmChannel.send(chunk);
    return;
  }

  try {
    for (const chunk of chunks) await user.send({ content: chunk });
    await interaction.editReply({
      content: "✅ Check your DMs!",
      flags: MessageFlags.Ephemeral,
    });
  } catch {
    // DMs are closed — tell the user, don't leak the answer to the channel
    await interaction.editReply({
      content: "❌ I couldn't DM you. Please enable **Direct Messages** from server members in your Privacy Settings and try again.",
      flags: MessageFlags.Ephemeral,
    });
  }
}

/** Split a long string into ≤2000-char chunks at newline boundaries. */
function splitMessage(text, maxLen = 1990) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > maxLen) {
    const slice = remaining.slice(0, maxLen);
    const splitAt = slice.lastIndexOf("\n") > 0 ? slice.lastIndexOf("\n") : maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Slash command registration ───────────────────────────────────────────────

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("ask")
      .setDescription("Ask the VibeCode AI a question — answer arrives in your DMs")
      .addStringOption((opt) =>
        opt
          .setName("question")
          .setDescription("Your question for VibeCode AI")
          .setRequired(true)
          .setMaxLength(500)
      )
      .toJSON(),
  ];

  const rest = new REST({ version: "10" }).setToken(BOT_TOKEN);
  console.log("Registering slash commands…");
  await rest.put(Routes.applicationGuildCommands(APPLICATION_ID, GUILD_ID), {
    body: commands,
  });
  console.log("Slash commands registered.");
}

// ─── Bot client ───────────────────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── Ready ─────────────────────────────────────────────────────────────────────

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);

  try {
    await registerCommands();
    await postStartupButton();
  } catch (err) {
    console.error("Startup error:", err);
  }
});

/**
 * Post (or refresh) the "Ask VibeCode AI" button in #vibecode-ai.
 * Deletes any previous bot messages in that channel to avoid duplicates.
 */
async function postStartupButton() {
  const channel = await client.channels.fetch(VIBECODE_CHANNEL_ID);
  if (!channel?.isTextBased()) return;

  // Clean up old bot messages so we don't pile up buttons on restarts
  const messages = await channel.messages.fetch({ limit: 20 });
  const botMessages = messages.filter((m) => m.author.id === client.user.id);
  for (const msg of botMessages.values()) await msg.delete().catch(() => {});

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_ask")
      .setLabel("💬 Ask VibeCode AI")
      .setStyle(ButtonStyle.Primary)
  );

  await channel.send({
    content: "**Welcome to VibeCode AI!**\nClick the button below or use `/ask` anywhere in the server to get an answer.",
    components: [row],
  });

  console.log("Startup button posted in #vibecode-ai.");
}

// ── Slash command: /ask ────────────────────────────────────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  // ── Button: open_ask → show modal ────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ask") {
    const modal = new ModalBuilder()
      .setCustomId("ask_modal")
      .setTitle("Ask VibeCode AI");

    const input = new TextInputBuilder()
      .setCustomId("question_input")
      .setLabel("Your question")
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder("e.g. How do I build an AI agent with Claude?")
      .setRequired(true)
      .setMaxLength(500);

    modal.addComponents(new ActionRowBuilder().addComponents(input));
    await interaction.showModal(modal);
    return;
  }

  // ── Modal submit: ask_modal ───────────────────────────────────────────────
  if (interaction.isModalSubmit() && interaction.customId === "ask_modal") {
    const userId = interaction.user.id;

    if (!checkRateLimit(userId)) {
      await interaction.reply({
        content: `⏳ Please wait **${cooldownRemaining(userId)}s** before asking again.`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const question = interaction.fields.getTextInputValue("question_input").trim();
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
      const answer = await askVibeCode(question);
      await sendAnswer(interaction.user, answer, interaction);
    } catch (err) {
      console.error("modal submit error:", err);
      await interaction.editReply({
        content: "❌ Sorry, I couldn't reach the VibeCode API right now. Try again in a moment.",
        flags: MessageFlags.Ephemeral,
      });
    }
    return;
  }

  // ── Slash command: /ask ───────────────────────────────────────────────────
  if (!interaction.isChatInputCommand() || interaction.commandName !== "ask") return;

  const userId = interaction.user.id;

  if (!checkRateLimit(userId)) {
    await interaction.reply({
      content: `⏳ Please wait **${cooldownRemaining(userId)}s** before asking again.`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const question = interaction.options.getString("question", true);

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const answer = await askVibeCode(question);
    await sendAnswer(interaction.user, answer, interaction);
  } catch (err) {
    console.error("/ask error:", err);
    await interaction.editReply({
      content: "❌ Sorry, I couldn't reach the VibeCode API right now. Try again in a moment.",
      flags: MessageFlags.Ephemeral,
    });
  }
});

// ── Direct messages ────────────────────────────────────────────────────────────

client.on(Events.MessageCreate, async (message) => {
  // Only handle DMs from non-bots
  if (message.author.bot) return;
  if (message.guild) return; // ignore guild messages (handled via /ask)

  const userId = message.author.id;
  const question = message.content.trim();
  if (!question) return;

  if (!checkRateLimit(userId)) {
    await message.reply(`⏳ Please wait **${cooldownRemaining(userId)}s** before asking again.`);
    return;
  }

  // Show typing indicator in DM
  await message.channel.sendTyping();

  try {
    const answer = await askVibeCode(question);
    await sendAnswer(null, answer, null, message.channel);
  } catch (err) {
    console.error("DM handler error:", err);
    await message.reply("❌ Sorry, I couldn't reach the VibeCode API right now. Try again in a moment.");
  }
});

// ─── Keep-alive HTTP server (required by Render) ──────────────────────────────

const app = express();
app.get("/", (_req, res) => res.send("VibeCode Discord Bot is running."));
app.listen(PORT, () => console.log(`HTTP keep-alive listening on port ${PORT}`));

// ─── Launch ───────────────────────────────────────────────────────────────────

client.login(BOT_TOKEN);
