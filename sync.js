require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder
} = require('discord.js');

const STORE_PATH = path.join(__dirname, 'store.json');
const ANILIST_API_URL = 'https://graphql.anilist.co';
const ANILIST_TOKEN_URL = 'https://anilist.co/api/v2/oauth/token';
const ANILIST_REDIRECT_URI = 'https://anilist.co/api/v2/oauth/pin';
const DISCORD_API_BASE_URL = 'https://discord.com/api/v9';

const config = {
  discordBotToken: process.env.DISCORD_BOT_TOKEN?.trim(),
  applicationId: process.env.APPLICATION_ID?.trim(),
  discordUserId: (process.env.DISCORD_USER_ID || '').replace(/\D/g, ''),
  anilistClientId: process.env.ANILIST_CLIENT_ID?.trim(),
  anilistClientSecret: process.env.ANILIST_CLIENT_SECRET?.trim()
};

function validateConfig() {
  const missing = [];

  if (!config.discordBotToken) missing.push('DISCORD_BOT_TOKEN');
  if (!config.applicationId) missing.push('APPLICATION_ID');
  if (!config.discordUserId) missing.push('DISCORD_USER_ID');
  if (!config.anilistClientId) missing.push('ANILIST_CLIENT_ID');
  if (!config.anilistClientSecret) missing.push('ANILIST_CLIENT_SECRET');

  if (missing.length) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function loadStore() {
  if (!fs.existsSync(STORE_PATH)) {
    return { anilistAccessToken: null, favorites: {} };
  }

  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    return {
      anilistAccessToken: data.anilistAccessToken || null,
      favorites: data.favorites || {}
    };
  } catch {
    return { anilistAccessToken: null, favorites: {} };
  }
}

function saveStore(store) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
}

async function aniListRequest(query, variables = {}, accessToken = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json'
  };

  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }

  const response = await axios.post(
    ANILIST_API_URL,
    { query, variables },
    { headers }
  );

  if (response.data?.errors?.length) {
    throw new Error(JSON.stringify(response.data.errors));
  }

  return response.data?.data;
}

async function exchangeCodeForToken(code) {
  const response = await axios.post(
    ANILIST_TOKEN_URL,
    {
      grant_type: 'authorization_code',
      client_id: config.anilistClientId,
      client_secret: config.anilistClientSecret,
      redirect_uri: ANILIST_REDIRECT_URI,
      code: code.trim()
    },
    {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json'
      }
    }
  );

  return response.data.access_token;
}

async function fetchAniListData(accessToken) {
  const query = `
    query {
      Viewer {
        id
        name
        avatar { large }
        statistics {
          anime { count meanScore minutesWatched }
          manga { count chaptersRead volumesRead }
        }
      }
    }
  `;

  const data = await aniListRequest(query, {}, accessToken);
  const user = data?.Viewer;

  if (!user) {
    throw new Error('No viewer data returned. Your link may have expired — run /link again.');
  }

  const anime = user.statistics?.anime ?? {};
  const manga = user.statistics?.manga ?? {};

  return {
    username: user.name,
    avatarUrl: user.avatar?.large || null,
    totalAnime: anime.count ?? 0,

    // keep as strings so the decimal place is preserved
    daysWatched: ((anime.minutesWatched ?? 0) / 60 / 24).toFixed(1),
    meanScore: Number(anime.meanScore ?? 0).toFixed(1),

    totalManga: manga.count ?? 0,
    chaptersRead: manga.chaptersRead ?? 0,
    volumesRead: manga.volumesRead ?? 0
  };
}

function getCategoryLabel(category) {
  switch (category) {
    case 'favorite_anime_name':
      return 'anime';
    case 'favorite_manga_name':
      return 'manga';
    case 'favorite_character_name':
      return 'character';
    default:
      return 'favorite';
  }
}

function getMediaTypeFromCategory(category) {
  if (category === 'favorite_anime_name') return 'ANIME';
  if (category === 'favorite_manga_name') return 'MANGA';
  return null;
}

function pickMediaTitle(media) {
  return (
    media?.title?.english ||
    media?.title?.romaji ||
    media?.title?.native ||
    `Media #${media?.id ?? 'Unknown'}`
  );
}

function pickCharacterName(character) {
  return (
    character?.name?.full ||
    character?.name?.native ||
    `Character #${character?.id ?? 'Unknown'}`
  );
}

function truncateChoice(text, max = 100) {
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

async function fetchMediaById(mediaType, id) {
  const query = `
    query ($id: Int) {
      Media(id: $id, type: ${mediaType}) {
        id
        title {
          english
          romaji
          native
        }
      }
    }
  `;

  const data = await aniListRequest(query, { id });
  return data?.Media || null;
}

async function searchMedia(mediaType, search, perPage = 10) {
  const query = `
    query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        media(search: $search, type: ${mediaType}) {
          id
          title {
            english
            romaji
            native
          }
        }
      }
    }
  `;

  const data = await aniListRequest(query, { search, perPage });
  return data?.Page?.media || [];
}

async function fetchCharacterById(id) {
  const query = `
    query ($id: Int) {
      Character(id: $id) {
        id
        name {
          full
          native
        }
      }
    }
  `;

  const data = await aniListRequest(query, { id });
  return data?.Character || null;
}

async function searchCharacters(search, perPage = 10) {
  const query = `
    query ($search: String, $perPage: Int) {
      Page(page: 1, perPage: $perPage) {
        characters(search: $search) {
          id
          name {
            full
            native
          }
        }
      }
    }
  `;

  const data = await aniListRequest(query, { search, perPage });
  return data?.Page?.characters || [];
}

async function getAutocompleteChoices(category, focusedValue) {
  const input = String(focusedValue || '').trim();
  if (!category || !input) return [];

  if (category === 'favorite_character_name') {
    if (/^\d+$/.test(input)) {
      const character = await fetchCharacterById(Number(input));
      if (!character) return [];
      return [
        {
          name: truncateChoice(`${pickCharacterName(character)} (#${character.id})`),
          value: String(character.id)
        }
      ];
    }

    const results = await searchCharacters(input, 10);
    return results.slice(0, 25).map(character => ({
      name: truncateChoice(`${pickCharacterName(character)} (#${character.id})`),
      value: String(character.id)
    }));
  }

  const mediaType = getMediaTypeFromCategory(category);
  if (!mediaType) return [];

  if (/^\d+$/.test(input)) {
    const media = await fetchMediaById(mediaType, Number(input));
    if (!media) return [];
    return [
      {
        name: truncateChoice(`${pickMediaTitle(media)} (#${media.id})`),
        value: String(media.id)
      }
    ];
  }

  const results = await searchMedia(mediaType, input, 10);
  return results.slice(0, 25).map(media => ({
    name: truncateChoice(`${pickMediaTitle(media)} (#${media.id})`),
    value: String(media.id)
  }));
}

async function resolveFavoriteValue(category, rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) {
    throw new Error('Please provide a value.');
  }

  const lowered = value.toLowerCase();
  if (['none', 'clear', 'remove', 'delete'].includes(lowered)) {
    return null;
  }

  if (category === 'favorite_character_name') {
    if (/^\d+$/.test(value)) {
      const character = await fetchCharacterById(Number(value));
      return character ? pickCharacterName(character) : value;
    }

    const results = await searchCharacters(value, 1);
    return results.length ? pickCharacterName(results[0]) : value;
  }

  const mediaType = getMediaTypeFromCategory(category);
  if (mediaType) {
    if (/^\d+$/.test(value)) {
      const media = await fetchMediaById(mediaType, Number(value));
      return media ? pickMediaTitle(media) : value;
    }

    const results = await searchMedia(mediaType, value, 1);
    return results.length ? pickMediaTitle(results[0]) : value;
  }

  return value;
}

function buildWidgetPayload(stats, favorites) {
  const dynamic = [
    { type: 1, name: 'name', value: stats.username },
    { type: 1, name: 'username', value: stats.username },

    { type: 1, name: 'favorite_anime', value: `Favorite Anime: ${favorites.favorite_anime_name || 'None'}` },
    { type: 1, name: 'favorite_manga', value: `Favorite Manga: ${favorites.favorite_manga_name || 'None'}` },
    { type: 1, name: 'favorite_character', value: `Favorite Character: ${favorites.favorite_character_name || 'None'}` },

    { type: 2, name: 'total_anime', value: String(stats.totalAnime) },
    { type: 1, name: 'days_watched', value: stats.daysWatched },     // type 1 + string for decimals
    { type: 1, name: 'mean_score', value: stats.meanScore },         // type 1 + string for decimals
    { type: 2, name: 'total_manga', value: String(stats.totalManga) },
    { type: 2, name: 'total_chapters_read', value: String(stats.chaptersRead) },
    { type: 2, name: 'total_volumes_read', value: String(stats.volumesRead) }
  ];

  if (stats.avatarUrl) {
    dynamic.push({ type: 3, name: 'avatar', value: { url: stats.avatarUrl } });
    dynamic.push({ type: 3, name: 'character_image', value: { url: stats.avatarUrl } });
  }

  return {
    username: stats.username,
    data: { dynamic }
  };
}

async function pushWidget(payload) {
  await axios.patch(
    `${DISCORD_API_BASE_URL}/applications/${config.applicationId}/users/${config.discordUserId}/identities/0/profile`,
    payload,
    {
      headers: {
        Authorization: `Bot ${config.discordBotToken}`,
        'Content-Type': 'application/json'
      }
    }
  );
}

const commands = [
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Link your Discord and AniList accounts')
    .setIntegrationTypes([1])
    .setContexts([0, 1, 2])
    .addStringOption(opt =>
      opt
        .setName('code')
        .setDescription('Paste the code from the AniList authorize page (leave empty to get the link)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('config')
    .setDescription('Set your favorite anime, manga, or character for your Discord profile')
    .setIntegrationTypes([1])
    .setContexts([0, 1, 2])
    .addStringOption(opt =>
      opt
        .setName('category')
        .setDescription('Which favorite to set')
        .setRequired(true)
        .addChoices(
          { name: 'Anime', value: 'favorite_anime_name' },
          { name: 'Manga', value: 'favorite_manga_name' },
          { name: 'Character', value: 'favorite_character_name' }
        )
    )
    .addStringOption(opt =>
      opt
        .setName('value')
        .setDescription('Start typing a name, or paste an AniList ID')
        .setRequired(true)
        .setAutocomplete(true)
    ),

  new SlashCommandBuilder()
    .setName('refresh')
    .setDescription('Forces a refresh of your data')
    .setIntegrationTypes([1])
    .setContexts([0, 1, 2])
].map(cmd => cmd.toJSON());

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

client.once('ready', () => {
  console.log(`Widget bot logged in as ${client.user.tag}`);
});

client.on('interactionCreate', async interaction => {
  if (interaction.isAutocomplete()) {
    if (interaction.user.id !== config.discordUserId) {
      await interaction.respond([]);
      return;
    }

    if (interaction.commandName !== 'config') {
      await interaction.respond([]);
      return;
    }

    const focused = interaction.options.getFocused(true);
    if (focused.name !== 'value') {
      await interaction.respond([]);
      return;
    }

    const category = interaction.options.getString('category');

    try {
      const choices = await getAutocompleteChoices(category, focused.value);
      await interaction.respond(choices);
    } catch (error) {
      console.error('Autocomplete failed:', error.response?.data || error.message);
      await interaction.respond([]).catch(() => {});
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  if (interaction.user.id !== config.discordUserId) {
    await interaction.reply({
      content: 'This bot only accepts commands from its owner.',
      ephemeral: true
    });
    return;
  }

  const store = loadStore();

  if (interaction.commandName === 'link') {
    const code = interaction.options.getString('code');

    if (!code) {
      const authorizeUrl =
        `https://anilist.co/api/v2/oauth/authorize?client_id=${config.anilistClientId}` +
        `&redirect_uri=${encodeURIComponent(ANILIST_REDIRECT_URI)}` +
        `&response_type=code`;

      await interaction.reply({
        content:
          `1. Open this link and authorize: ${authorizeUrl}\n` +
          `2. Copy the code shown on the page.\n` +
          `3. Run \`/link code:<paste code here>\``,
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const accessToken = await exchangeCodeForToken(code);
      store.anilistAccessToken = accessToken;
      saveStore(store);
      await interaction.editReply('Linked! Run /refresh to sync your stats now.');
    } catch (error) {
      const details = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;

      console.error('Link failed:', details);
      await interaction.editReply(
        `Linking failed: ${details}\nCodes are single-use — run /link again for a fresh one.`
      );
    }

    return;
  }

  if (interaction.commandName === 'config') {
    const category = interaction.options.getString('category');
    const rawValue = interaction.options.getString('value');

    await interaction.deferReply({ ephemeral: true });

    try {
      const resolvedValue = await resolveFavoriteValue(category, rawValue);
      const label = getCategoryLabel(category);

      if (resolvedValue === null) {
        delete store.favorites[category];
        saveStore(store);
        await interaction.editReply(`Cleared favorite ${label}. Run /refresh to apply it.`);
        return;
      }

      store.favorites[category] = resolvedValue;
      saveStore(store);

      await interaction.editReply(
        `Set favorite ${label} to "${resolvedValue}". Run /refresh to apply it.`
      );
    } catch (error) {
      const details = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;

      console.error('Config failed:', details);
      await interaction.editReply(`Config failed: ${details}`);
    }

    return;
  }

  if (interaction.commandName === 'refresh') {
    if (!store.anilistAccessToken) {
      await interaction.reply({
        content: 'Link your account first with /link.',
        ephemeral: true
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const stats = await fetchAniListData(store.anilistAccessToken);
      const payload = buildWidgetPayload(stats, store.favorites);
      await pushWidget(payload);
      await interaction.editReply('Widget refreshed with your latest AniList stats.');
    } catch (error) {
      const details = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;

      console.error('Refresh failed:', details);
      await interaction.editReply(`Refresh failed: ${details}`);
    }

    return;
  }
});

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(config.discordBotToken);
  await rest.put(Routes.applicationCommands(config.applicationId), { body: commands });
  console.log('Slash commands registered.');
}

validateConfig();

registerCommands()
  .then(() => client.login(config.discordBotToken))
  .catch(err => console.error('Failed to register commands:', err));
