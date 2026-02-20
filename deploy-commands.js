'use strict';

require('dotenv').config();

const { REST, Routes, SlashCommandBuilder } = require('discord.js');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var: ${name}`);
  return v;
}

const token = mustEnv('DISCORD_TOKEN');
const clientId = mustEnv('CLIENT_ID');
const guildIds = [mustEnv('GUILD_ID'), process.env.GUILD_ID_2].filter(Boolean);

const commands = [
  new SlashCommandBuilder()
    .setName('mola')
    .setDescription('Rezervasyonlu normal mola başlat')
    .addIntegerOption((opt) =>
      opt
        .setName('sure')
        .setDescription('Mola süresi')
        .setRequired(true)
        .addChoices(
          { name: '10', value: 10 },
          { name: '20', value: 20 }
        )
    ),

  new SlashCommandBuilder()
    .setName('acil')
    .setDescription('Acil mola başlat (rez gerekmez, 1 saat kuralını bypass eder)')
    .addIntegerOption((opt) =>
      opt
        .setName('sure')
        .setDescription('Mola süresi')
        .setRequired(true)
        .addChoices(
          { name: '10', value: 10 },
          { name: '20', value: 20 }
        )
    ),

  new SlashCommandBuilder()
    .setName('devam')
    .setDescription('Aktif molayı bitir'),

  new SlashCommandBuilder()
    .setName('hak')
    .setDescription('Haklarını ve durumunu göster'),

  new SlashCommandBuilder()
    .setName('ekstra')
    .setDescription('Ekstra mola başlat (vardiya dışı, admin tarafından verilmiş hak)')
    .addIntegerOption((opt) =>
      opt
        .setName('sure')
        .setDescription('Mola süresi')
        .setRequired(true)
        .addChoices(
          { name: '5 dk', value: 5 },
          { name: '10 dk', value: 10 },
          { name: '20 dk', value: 20 }
        )
    ),

  new SlashCommandBuilder()
    .setName('rez')
    .setDescription('Mola rezervasyonu al')
    .addIntegerOption((opt) =>
      opt
        .setName('sure')
        .setDescription('Rez süresi')
        .setRequired(true)
        .addChoices(
          { name: '10', value: 10 },
          { name: '20', value: 20 }
        )
    )
    .addStringOption((opt) =>
      opt
        .setName('saat')
        .setDescription('Saat (HH:MM veya HH.MM)')
        .setRequired(true)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('bekle')
        .setDescription('Doluysa bekleme listesine ekle (ping)')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('rezliste')
    .setDescription('Rez listesini ve havuz durumunu göster'),

  new SlashCommandBuilder()
    .setName('reziptal')
    .setDescription('Rez iptal et')
    .addStringOption((opt) =>
      opt
        .setName('saat')
        .setDescription('İptal edilecek rez saati (HH:MM)')
        .setRequired(false)
    )
    .addBooleanOption((opt) =>
      opt
        .setName('hepsi')
        .setDescription('Tüm rezleri iptal et')
        .setRequired(false)
    ),

  new SlashCommandBuilder()
    .setName('admin')
    .setDescription('Yönetici komutları')
    .setDefaultMemberPermissions(0)
    .addSubcommand((sub) =>
      sub
        .setName('rapor')
        .setDescription('Vardiya raporu görüntüle')
        .addStringOption((opt) =>
          opt
            .setName('havuz')
            .setDescription('Havuz seçimi (boş bırakılırsa tüm havuzlar özeti)')
            .setRequired(false)
            .addChoices(
              { name: 'Sabah', value: 'sabah' },
              { name: 'Akşam', value: 'aksam' },
              { name: 'Gece', value: 'gece' }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('tarih')
            .setDescription('Tarih (GG.AA.YYYY / bugun / dun)')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('donem')
            .setDescription('Rapor dönemi')
            .setRequired(false)
            .addChoices(
              { name: 'Gün', value: 'gun' },
              { name: 'Hafta', value: 'hafta' },
              { name: 'Ay', value: 'ay' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('kullanici')
        .setDescription('Kullanıcı mola geçmişini görüntüle')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('tarih')
            .setDescription('Başlangıç tarihi (GG.AA.YYYY / bugun / dun)')
            .setRequired(false)
        )
        .addStringOption((opt) =>
          opt
            .setName('tarih2')
            .setDescription('Bitiş tarihi — belirtilirse aralık gösterilir (GG.AA.YYYY / bugun / dun)')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('hak-ver')
        .setDescription('Kullanıcıya ek mola hakkı ver')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('sure')
            .setDescription('Hak süresi (dk)')
            .setRequired(true)
            .addChoices(
              { name: '5 dk', value: 5 },
              { name: '10 dk', value: 10 },
              { name: '20 dk', value: 20 }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('hak-al')
        .setDescription('Kullanıcıdan mola hakkı al')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('sure')
            .setDescription('Hak süresi (dk)')
            .setRequired(true)
            .addChoices(
              { name: '5 dk', value: 5 },
              { name: '10 dk', value: 10 },
              { name: '20 dk', value: 20 }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('tur')
            .setDescription('Hak türü')
            .setRequired(true)
            .addChoices(
              { name: 'Normal (vardiya hakkı)', value: 'normal' },
              { name: 'Ekstra', value: 'ekstra' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('mola-bitir')
        .setDescription('Kullanıcının aktif molasını zorla sonlandır')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('rez-ver')
        .setDescription('Kullanıcı adına rezervasyon oluştur (hak düşülmez)')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
        .addIntegerOption((opt) =>
          opt
            .setName('sure')
            .setDescription('Rez süresi (dk)')
            .setRequired(true)
            .addChoices(
              { name: '10 dk', value: 10 },
              { name: '20 dk', value: 20 }
            )
        )
        .addStringOption((opt) =>
          opt
            .setName('saat')
            .setDescription('Rez saati (HH:MM veya HH.MM)')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('havuz')
            .setDescription('Havuz')
            .setRequired(true)
            .addChoices(
              { name: 'Sabah', value: 'morning' },
              { name: 'Akşam', value: 'evening' },
              { name: 'Gece', value: 'night' }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('rez-iptal')
        .setDescription('Kullanıcının rezervasyonunu iptal et')
        .addUserOption((opt) =>
          opt
            .setName('kullanici')
            .setDescription('Hedef kullanıcı')
            .setRequired(true)
        )
        .addStringOption((opt) =>
          opt
            .setName('saat')
            .setDescription('İptal edilecek rez saati (belirtilmezse ilk rez)')
            .setRequired(false)
        )
        .addBooleanOption((opt) =>
          opt
            .setName('hepsi')
            .setDescription('Tüm rezleri iptal et')
            .setRequired(false)
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('mola-al')
        .setDescription('Kendi admin molasını başlat (rez yok, kural yok)')
        .addIntegerOption((opt) =>
          opt
            .setName('sure')
            .setDescription('Mola süresi (dk)')
            .setRequired(true)
            .addChoices(
              { name: '10 dk', value: 10 },
              { name: '20 dk', value: 20 }
            )
        )
    )
    .addSubcommand((sub) =>
      sub
        .setName('devam')
        .setDescription('Kendi admin molasını bitir')
    )
    .addSubcommand((sub) =>
      sub
        .setName('restart')
        .setDescription('Botu yeniden başlat')
    )
].map((c) => c.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

(async () => {
  try {
    for (const guildId of guildIds) {
      console.log('⏳ Slash komutları yükleniyor: ' + guildId);
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
      console.log('✅ Yüklendi: ' + guildId);
    }
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();
