// index.js

const express = require('express');
const { Telegraf } = require('telegraf');
const { google } = require('googleapis');

// --- Конфиг из переменных окружения ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const SHEET_ID = process.env.SHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON; // сюда вставим JSON ключ
const PUBLIC_URL = process.env.PUBLIC_URL; // URL сервиса на Render, вида https://имя.onrender.com

if (!BOT_TOKEN) {
  throw new Error('Не задан BOT_TOKEN');
}
if (!SHEET_ID) {
  throw new Error('Не задан SHEET_ID');
}
if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
  throw new Error('Не задан GOOGLE_SERVICE_ACCOUNT_JSON');
}

// --- Подключение к Google Sheets ---
function getSheetsClient() {
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);

  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );

  const sheets = google.sheets({ version: 'v4', auth });
  return { sheets, auth };
}

async function saveReportToSheet(chatId, data) {
  const { sheets, auth } = getSheetsClient();
  await auth.authorize();

  const values = [[
    new Date().toISOString(), // Timestamp
    String(chatId),
    data.people || '',
    data.hours || '',
    data.extraWorks || '',
    data.extraCost || ''
  ]];

  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: 'Отчёты!A:F',
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values }
  });
}

// --- Логика бота ---
const QUESTIONS = [
  '1) Сколько человек было на объекте? (Числовой ответ)',
  '2) Сколько времени потратили? (Числовой ответ, часы или человеко-часы)',
  '3) Какие доп работы делали? (Текстовый ответ)',
  '4) Сколько денег потратили на доп работы? (Числовой ответ)'
];

// простая сессия в памяти: chatId -> { step, data }
const sessions = new Map();

function getSession(chatId) {
  if (!sessions.has(chatId)) {
    sessions.set(chatId, { step: 0, data: {} });
  }
  return sessions.get(chatId);
}

const bot = new Telegraf(BOT_TOKEN);

// /start — начинаем новый отчёт
bot.start(async (ctx) => {
  const chatId = String(ctx.chat.id);
  sessions.set(chatId, { step: 1, data: {} });

  await ctx.reply(
    'Привет! Я бот для сбора отчётов.\n' +
    'Ответь, пожалуйста, на несколько вопросов.'
  );
  await ctx.reply(QUESTIONS[0]);
});

// Обработка всех текстовых сообщений, кроме /start
bot.on('text', async (ctx) => {
  const chatId = String(ctx.chat.id);
  const text = ctx.message.text.trim();

  // если это команда, но не /start — игнорируем
  if (text.startsWith('/') && text !== '/start') {
    return;
  }

  const session = getSession(chatId);
  let { step, data } = session;

  if (step === 0) {
    await ctx.reply('Напиши /start чтобы начать новый отчёт.');
    return;
  }

  if (step === 1) {
    const people = parseInt(text.replace(',', '.'));
    if (isNaN(people)) {
      await ctx.reply('Нужно ввести число. Сколько человек было на объекте?');
      return;
    }
    data.people = people;
    session.step = 2;
    await ctx.reply(QUESTIONS[1]);
    return;
  }

  if (step === 2) {
    const hours = parseFloat(text.replace(',', '.'));
    if (isNaN(hours)) {
      await ctx.reply('Нужно ввести число. Сколько времени потратили (в часах)?');
      return;
    }
    data.hours = hours;
    session.step = 3;
    await ctx.reply(QUESTIONS[2]);
    return;
  }

  if (step === 3) {
    data.extraWorks = text;
    session.step = 4;
    await ctx.reply(QUESTIONS[3]);
    return;
  }

  if (step === 4) {
    const cost = parseFloat(text.replace(',', '.'));
    if (isNaN(cost)) {
      await ctx.reply('Нужно ввести число. Сколько денег потратили на доп работы?');
      return;
    }
    data.extraCost = cost;

    try {
      await saveReportToSheet(chatId, data);
      sessions.delete(chatId);
      await ctx.reply('Спасибо! Отчёт записан в таблицу.\nЕсли нужен ещё один — отправь /start.');
    } catch (e) {
      console.error('Ошибка записи в таблицу', e);
      await ctx.reply('Произошла ошибка при записи в таблицу. Сообщи администратору.');
    }
    return;
  }
});

// --- Сервер для webhooks ---
const app = express();
app.use(express.json());

// Telegram будет слать апдейты сюда
app.post(`/webhook/${BOT_TOKEN}`, (req, res) => {
  bot.handleUpdate(req.body);
  res.sendStatus(200);
});

// простой health check
app.get('/', (req, res) => {
  res.send('Bot is running');
});

// Запуск сервера
const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
  console.log(`Server is running on port ${PORT}`);

  if (PUBLIC_URL) {
    const webhookUrl = `${PUBLIC_URL}/webhook/${BOT_TOKEN}`;
    try {
      await bot.telegram.setWebhook(webhookUrl);
      console.log('Webhook set to', webhookUrl);
    } catch (e) {
      console.error('Ошибка установки webhook:', e);
    }
  } else {
    console.log('PUBLIC_URL не задан, webhook не установлен');
  }
});
