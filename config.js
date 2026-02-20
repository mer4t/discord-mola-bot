'use strict';

require('dotenv').config();

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

function optEnv(name) {
  return process.env[name] || '';
}

function parseIds(str) {
  return str.split(',').map((s) => s.trim()).filter(Boolean);
}

const GUILD_CONFIGS = [];

// Guild 1
GUILD_CONFIGS.push({
  guildId: mustEnv('GUILD_ID'),
  adminRoleIds: parseIds(optEnv('ADMIN_ROLE_ID')),
  channels: {
    morning: {
      mola: [mustEnv('MORNING_MOLA_CHANNEL_ID')],
      rez:  [mustEnv('MORNING_REZ_CHANNEL_ID')]
    },
    evening: {
      mola: [mustEnv('EVENING_MOLA_CHANNEL_ID')],
      rez:  [mustEnv('EVENING_REZ_CHANNEL_ID')]
    },
    night: {
      mola: [mustEnv('NIGHT_MOLA_CHANNEL_ID')],
      rez:  [mustEnv('NIGHT_REZ_CHANNEL_ID')]
    }
  },
  adminBreakChannelIds: parseIds(optEnv('ADMIN_BREAK_CHANNEL_IDS'))
});

// Guild 2 (opsiyonel)
if (process.env.GUILD_ID_2) {
  GUILD_CONFIGS.push({
    guildId: process.env.GUILD_ID_2,
    adminRoleIds: parseIds(optEnv('ADMIN_ROLE_ID')),
    channels: {
      morning: {
        mola: [optEnv('G2_MORNING_MOLA_CHANNEL_ID')].filter(Boolean),
        rez:  [optEnv('G2_MORNING_REZ_CHANNEL_ID')].filter(Boolean)
      },
      evening: {
        mola: [optEnv('G2_EVENING_MOLA_CHANNEL_ID')].filter(Boolean),
        rez:  [optEnv('G2_EVENING_REZ_CHANNEL_ID')].filter(Boolean)
      },
      night: {
        mola: [optEnv('G2_NIGHT_MOLA_CHANNEL_ID')].filter(Boolean),
        rez:  [optEnv('G2_NIGHT_REZ_CHANNEL_ID')].filter(Boolean)
      }
    },
    adminBreakChannelIds: parseIds(optEnv('G2_ADMIN_BREAK_CHANNEL_IDS'))
  });
}

const CONFIG = {
  token: mustEnv('DISCORD_TOKEN'),
  clientId: mustEnv('CLIENT_ID'),
  timezone: process.env.TZ || 'Europe/Istanbul',
  guildConfigs: GUILD_CONFIGS
};

module.exports = { CONFIG };
