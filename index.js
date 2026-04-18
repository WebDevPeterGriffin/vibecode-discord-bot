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
 * Try to DM the user. If DMs are closed, reply ephemerally via interaction.
 * `interaction` may be null when handling a raw DM message (no slash context).
 */
async function sendAnswer(user, answer, interaction = null) {
  // Chunk long answers to respect Discord's 2000-char limit
  const chunks = splitMessage(answer);

  if (interaction) {
    // Always follow-up via the interaction channel (ephemeral) — DM separately
    try {
      await user.send({ content: chunks[0] });
      for (const chunk of chunks.slice(1)) await user.send({ content: chunk });
      await interaction.editReply({
        content: "✅ I sent the answer to your DMs!",
        flags: MessageFlags.Ephemeral,
      });
    } catch {
      // DMs disabled — fall back to ephemeral reply in channel
      await interaction.editReply({
        content: chunks[0],
        flags: MessageFlags.Ephemeral,
      });
      for (const chunk of chunks.slice(1)) {
        await interaction.followUp({ content: chunk, flags: MessageFlags.Ephemeral });
      }
    }
  } else {
    // Raw DM context — just reply in the DM channel
    return chunks; // caller handles sending
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
  // ── Button: open_ask ──────────────────────────────────────────────────────
  if (interaction.isButton() && interaction.customId === "open_ask") {
    await interaction.reply({
      content: "Use `/ask question:<your question>` anywhere in the server and I'll DM you the answer! 🤖",
      flags: MessageFlags.Ephemeral,
    });
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

  // Defer so we have time to call the API (shows "thinking…" in Discord)
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  // Show typing in the channel while we wait (best-effort)
  interaction.channel?.sendTyping().catch(() => {});

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
    const chunks = splitMessage(answer);
    for (const chunk of chunks) {
      await message.channel.send(chunk);
    }
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
