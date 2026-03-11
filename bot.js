const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ======================= CONFIG =======================
const BOT_TOKEN = '8714218476:AAHseToA2mid2asO1RSbu5QO70RQfg3v4Gg';
const API_URL = 'https://ab-faceswap.vercel.app/swap';
const BOT_USERNAME = 'faceeswappbot';
const FORCE_JOIN = '@saveemoney';
const SUPPORT_USERNAME = '@danishh0077';
const ADMIN_IDS = [7065784096];
const FREE_START_CREDITS = 5;
const REFERRAL_REWARD = 3;
const CREDITS_PER_RUPEE = 2;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const db = loadDb();

function loadDb() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      users: {},
      payments: {},
      adminReplyMap: {},
      qrFileId: '',
      nextPaymentId: 1
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    const seed = {
      users: {},
      payments: {},
      adminReplyMap: {},
      qrFileId: '',
      nextPaymentId: 1
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
}

function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function isAdmin(id) {
  return ADMIN_IDS.includes(id);
}

function userRecord(user) {
  const id = String(user.id);
  if (!db.users[id]) {
    db.users[id] = {
      id: user.id,
      first_name: user.first_name || '',
      username: user.username || '',
      credits: FREE_START_CREDITS,
      joinedVerified: false,
      state: null,
      temp: {},
      referredBy: null,
      referrals: [],
      referralCreditsGiven: false,
      createdAt: Date.now()
    };
    saveDb();
  }
  return db.users[id];
}

function setState(userId, state, temp = {}) {
  const u = db.users[String(userId)];
  if (!u) return;
  u.state = state;
  u.temp = temp;
  saveDb();
}

function clearState(userId) {
  const u = db.users[String(userId)];
  if (!u) return;
  u.state = null;
  u.temp = {};
  saveDb();
}

function mainKeyboard() {
  return {
    resize_keyboard: true,
    keyboard: [
      [{ text: '🪙 Balance' }, { text: '🛒 Buy Credits' }],
      [{ text: '🎭 Start FaceSwap' }, { text: '👥 Refer & Earn' }],
      [{ text: '📜 Rules' }, { text: '🆘 Support' }]
    ]
  };
}

function forceJoinKeyboard(userId) {
  return {
    inline_keyboard: [
      [{ text: '📢 Join Group', url: 'https://t.me/saveemoney' }],
      [{ text: '✅ Verify', callback_data: `verify_${userId}` }]
    ]
  };
}

function paymentKeyboard(paymentId) {
  return {
    inline_keyboard: [
      [{ text: '✅ Paid', callback_data: `paid_${paymentId}` }],
      [{ text: '❌ Cancel Payment', callback_data: `cancelpay_${paymentId}` }]
    ]
  };
}

function adminPaymentKeyboard(paymentId) {
  return {
    inline_keyboard: [
      [
        { text: '✅ Add Credits', callback_data: `approve_${paymentId}` },
        { text: '❌ Cancel', callback_data: `reject_${paymentId}` }
      ]
    ]
  };
}

function referralLink(userId) {
  return `https://t.me/${BOT_USERNAME}?start=${userId}`;
}

async function ensureJoined(userId) {
  try {
    const member = await bot.getChatMember(FORCE_JOIN, userId);
    const ok = ['member', 'administrator', 'creator'].includes(member.status);
    if (db.users[String(userId)]) {
      db.users[String(userId)].joinedVerified = ok;
      saveDb();
    }
    return ok;
  } catch {
    return false;
  }
}

async function sendRules(chatId, name = 'bro') {
  const text =
`✨ *Welcome ${escapeMd(name)}!*\n\n` +
`🎭 *FaceSwap Credit Rules*\n` +
`• 1 photo swap = 1 credit\n` +
`• New users get *${FREE_START_CREDITS} free credits*\n` +
`• 1 successful referral = *${REFERRAL_REWARD} credits*\n` +
`• *${CREDITS_PER_RUPEE} credits = ₹1*\n\n` +
`📌 *How to use*\n` +
`1. Send first photo\n` +
`2. Send second photo\n` +
`3. Bot swaps and sends result\n\n` +
`💳 Buy more credits from the Buy Credits button.\n` +
`🆘 Any issue: ${SUPPORT_USERNAME}`;
  return bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: mainKeyboard() });
}

function escapeMd(text = '') {
  return String(text).replace(/([_\-*\[\]()~`>#+=|{}.!])/g, '\\$1');
}

async function notifyAdminsFromUser(msg, extraText = '') {
  for (const adminId of ADMIN_IDS) {
    try {
      const header =
`📩 User Message\n` +
`👤 ${msg.from.first_name || ''} ${msg.from.last_name || ''}\n` +
`🆔 ${msg.from.id}\n` +
`🔗 @${msg.from.username || 'no_username'}${extraText ? `\n${extraText}` : ''}`;
      const h = await bot.sendMessage(adminId, header.trim());
      db.adminReplyMap[String(h.message_id)] = { userId: msg.from.id, kind: 'header' };
      const copied = await bot.copyMessage(adminId, msg.chat.id, msg.message_id);
      db.adminReplyMap[String(copied.message_id)] = { userId: msg.from.id, kind: 'copy' };
      saveDb();
    } catch (e) {
      console.error('notifyAdminsFromUser error:', e.message);
    }
  }
}

async function routeAdminReply(msg) {
  if (!msg.reply_to_message) return false;
  const mapped = db.adminReplyMap[String(msg.reply_to_message.message_id)];
  if (!mapped || !mapped.userId) return false;
  try {
    if (msg.text && msg.text.startsWith('/')) return false;
    await bot.copyMessage(mapped.userId, msg.chat.id, msg.message_id);
    await bot.sendMessage(msg.chat.id, '✅ Message sent to user.');
    return true;
  } catch (e) {
    await bot.sendMessage(msg.chat.id, '❌ Failed to send reply to user.');
    return true;
  }
}

async function startHandler(msg, startPayload = null) {
  const user = userRecord(msg.from);

  if (startPayload) {
    const refId = String(startPayload);
    if (refId !== String(msg.from.id) && db.users[refId] && !user.referredBy) {
      user.referredBy = Number(refId);
      saveDb();
    }
  }

  const joined = await ensureJoined(msg.from.id);
  if (!joined) {
    await bot.sendMessage(
      msg.chat.id,
      '🚫 *First join our group to use this bot.*\n\nAfter joining, tap *Verify* below.',
      {
        parse_mode: 'Markdown',
        reply_markup: forceJoinKeyboard(msg.from.id)
      }
    );
    return;
  }

  await sendRules(msg.chat.id, msg.from.first_name || 'bro');
}

async function verifyReferralForUser(userId) {
  const user = db.users[String(userId)];
  if (!user || !user.referredBy || user.referralCreditsGiven) return;
  const referrer = db.users[String(user.referredBy)];
  if (!referrer) return;

  // award only once per verified user
  user.referralCreditsGiven = true;
  if (!referrer.referrals.includes(user.id)) {
    referrer.referrals.push(user.id);
    referrer.credits += REFERRAL_REWARD;
  }
  saveDb();

  try {
    await bot.sendMessage(
      referrer.id,
      `🎉 Referral success!\n\nYou earned *${REFERRAL_REWARD} credits* because your referral joined and verified.\n\n🪙 New balance: *${referrer.credits}*`,
      { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
    );
  } catch {}
}

async function beginFaceswap(chatId, userId) {
  setState(userId, 'await_source_photo');
  await bot.sendMessage(
    chatId,
    '🎭 *FaceSwap Started*\n\n📸 Send the *first photo* now.\nThis will be used as the *source face*.',
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
}

function createPayment(userId, credits) {
  const paymentId = String(db.nextPaymentId++);
  const amount = Number((credits / CREDITS_PER_RUPEE).toFixed(2));
  db.payments[paymentId] = {
    id: paymentId,
    userId,
    credits,
    amount,
    status: 'awaiting_paid_click',
    createdAt: Date.now(),
    screenshotFileId: null,
    adminMessageIds: []
  };
  saveDb();
  return db.payments[paymentId];
}

async function showPaymentQr(chatId, payment) {
  const text =
`💳 *Credit Purchase*\n\n` +
`🪙 Credits: *${payment.credits}*\n` +
`💰 Amount: *₹${payment.amount}*\n\n` +
`After payment, tap *Paid* and send screenshot.\n\n` +
`Need help? ${SUPPORT_USERNAME}`;

  if (db.qrFileId) {
    await bot.sendPhoto(chatId, db.qrFileId, {
      caption: text,
      parse_mode: 'Markdown',
      reply_markup: paymentKeyboard(payment.id)
    });
  } else {
    await bot.sendMessage(chatId, text + '\n\n⚠️ Admin has not set QR yet.', {
      parse_mode: 'Markdown',
      reply_markup: paymentKeyboard(payment.id)
    });
  }
}

async function notifyAdminsAboutPaid(payment) {
  const user = db.users[String(payment.userId)] || { id: payment.userId };
  for (const adminId of ADMIN_IDS) {
    try {
      const sent = await bot.sendMessage(
        adminId,
`💸 *New Payment Request*\n\n` +
`👤 User: ${escapeMd(user.first_name || '')} (@${escapeMd(user.username || 'no_username')})\n` +
`🆔 ID: *${payment.userId}*\n` +
`🪙 Credits Ordered: *${payment.credits}*\n` +
`💰 Amount: *₹${payment.amount}*\n` +
`🧾 Payment ID: *${payment.id}*\n\n` +
`Reply to this message to chat with the buyer.`,
        {
          parse_mode: 'Markdown',
          reply_markup: adminPaymentKeyboard(payment.id)
        }
      );
      payment.adminMessageIds.push(sent.message_id);
      db.adminReplyMap[String(sent.message_id)] = { userId: payment.userId, kind: 'payment' };
      if (payment.screenshotFileId) {
        const shot = await bot.sendPhoto(adminId, payment.screenshotFileId, {
          caption: `📷 Screenshot from user ${payment.userId} for payment #${payment.id}`
        });
        db.adminReplyMap[String(shot.message_id)] = { userId: payment.userId, kind: 'payment_shot' };
      }
      saveDb();
    } catch (e) {
      console.error('notifyAdminsAboutPaid:', e.message);
    }
  }
}

async function downloadTelegramFile(fileId) {
  const url = await bot.getFileLink(fileId);
  const ext = path.extname(url.split('?')[0]) || '.jpg';
  const tmp = path.join(os.tmpdir(), `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  const response = await axios.get(url, { responseType: 'arraybuffer' });
  fs.writeFileSync(tmp, response.data);
  return tmp;
}

async function processSwap(chatId, userId, sourceFileId, targetFileId) {
  const user = db.users[String(userId)];
  if (!user) return;

  if (user.credits < 1) {
    clearState(userId);
    await bot.sendMessage(chatId, '❌ You need at least *1 credit* for one swap. Tap *Buy Credits* to continue.', {
      parse_mode: 'Markdown',
      reply_markup: mainKeyboard()
    });
    return;
  }

  let sourcePath, targetPath;
  try {
    await bot.sendMessage(chatId, '⏳ Processing your FaceSwap... Please wait.');
    sourcePath = await downloadTelegramFile(sourceFileId);
    targetPath = await downloadTelegramFile(targetFileId);

    const form = new FormData();
    form.append('source', fs.createReadStream(sourcePath));
    form.append('target', fs.createReadStream(targetPath));

    const response = await axios.post(API_URL, form, {
      headers: form.getHeaders(),
      responseType: 'arraybuffer',
      timeout: 120000
    });

    user.credits -= 1;
    clearState(userId);
    saveDb();

    await bot.sendPhoto(chatId, Buffer.from(response.data), {
      caption: `✅ FaceSwap done!\n\n🪙 1 credit used\n💼 Remaining credits: ${user.credits}`,
      reply_markup: mainKeyboard()
    });
  } catch (e) {
    console.error('processSwap error:', e.response?.status, e.message);
    clearState(userId);
    await bot.sendMessage(chatId, '❌ FaceSwap failed right now. Please try again in a bit.', {
      reply_markup: mainKeyboard()
    });
  } finally {
    [sourcePath, targetPath].filter(Boolean).forEach((p) => {
      try { fs.unlinkSync(p); } catch {}
    });
  }
}

async function handleTextStates(msg, text) {
  const user = userRecord(msg.from);
  const state = user.state;

  if (state === 'await_buy_credits') {
    const credits = parseInt(text, 10);
    if (!Number.isFinite(credits) || credits <= 0) {
      await bot.sendMessage(msg.chat.id, '❌ Please send a valid number of credits. Example: *10*', { parse_mode: 'Markdown' });
      return true;
    }
    const payment = createPayment(msg.from.id, credits);
    clearState(msg.from.id);
    await showPaymentQr(msg.chat.id, payment);
    return true;
  }

  return false;
}

bot.onText(/^\/start(?:\s+(.+))?$/, async (msg, match) => {
  const payload = match && match[1] ? match[1].trim() : null;
  await startHandler(msg, payload);
});

bot.onText(/^\/balance$/, async (msg) => {
  const user = userRecord(msg.from);
  const joined = await ensureJoined(msg.from.id);
  if (!joined) {
    return bot.sendMessage(msg.chat.id, '🚫 First join the group, then verify.', {
      reply_markup: forceJoinKeyboard(msg.from.id)
    });
  }
  await bot.sendMessage(msg.chat.id,
    `🪙 *Your Balance*\n\nCredits: *${user.credits}*\nReferrals: *${user.referrals.length}*`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});

bot.onText(/^\/buy$/, async (msg) => {
  const joined = await ensureJoined(msg.from.id);
  if (!joined) {
    return bot.sendMessage(msg.chat.id, '🚫 First join the group, then verify.', {
      reply_markup: forceJoinKeyboard(msg.from.id)
    });
  }
  setState(msg.from.id, 'await_buy_credits');
  await bot.sendMessage(msg.chat.id,
    `🛒 *Buy Credits*\n\nSend how many credits you want to buy.\n\n💰 Rate: *${CREDITS_PER_RUPEE} credits = ₹1*`,
    { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
  );
});

bot.onText(/^\/(field|fileid|setqr)$/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  if (!msg.reply_to_message || !msg.reply_to_message.photo) {
    return bot.sendMessage(msg.chat.id, 'Reply to a photo with this command.');
  }
  const photo = msg.reply_to_message.photo[msg.reply_to_message.photo.length - 1];
  const fileId = photo.file_id;

  if (match[1] === 'setqr') {
    db.qrFileId = fileId;
    saveDb();
    return bot.sendMessage(msg.chat.id, `✅ QR updated.\n\nFile ID:\n\
${fileId}`);
  }
  return bot.sendMessage(msg.chat.id, `📌 File ID:\n\
${fileId}`);
});


bot.onText(/^\/qrstatus$/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  if (!db.qrFileId) {
    return bot.sendMessage(msg.chat.id, '⚠️ No QR is set yet. Reply to a QR photo with /setqr');
  }
  return bot.sendPhoto(msg.chat.id, db.qrFileId, { caption: '✅ Current QR is saved and working.' });
});

bot.on('callback_query', async (query) => {
  const { data, from, message } = query;
  try { await bot.answerCallbackQuery(query.id); } catch {}

  if (data.startsWith('verify_')) {
    const userId = Number(data.split('_')[1]);
    if (userId !== from.id) return;
    const joined = await ensureJoined(from.id);
    if (!joined) {
      return bot.sendMessage(message.chat.id, '❌ Not verified yet. Please join the group first, then tap Verify again.', {
        reply_markup: forceJoinKeyboard(from.id)
      });
    }
    await verifyReferralForUser(from.id);
    return sendRules(message.chat.id, from.first_name || 'bro');
  }

  if (data.startsWith('paid_')) {
    const paymentId = data.split('_')[1];
    const payment = db.payments[paymentId];
    if (!payment || payment.userId !== from.id) return;
    payment.status = 'awaiting_screenshot';
    saveDb();
    setState(from.id, 'await_payment_screenshot', { paymentId });
    return bot.sendMessage(
      message.chat.id,
      `📷 Send your payment screenshot now.\n\nAfter checking, credits will be added if payment is done.\nAny problem contact ${SUPPORT_USERNAME}`,
      { reply_markup: mainKeyboard() }
    );
  }

  if (data.startsWith('cancelpay_')) {
    const paymentId = data.split('_')[1];
    const payment = db.payments[paymentId];
    if (!payment || payment.userId !== from.id) return;
    payment.status = 'cancelled_by_user';
    saveDb();
    clearState(from.id);
    return bot.sendMessage(message.chat.id, '❌ Payment request cancelled.', { reply_markup: mainKeyboard() });
  }

  if (data.startsWith('approve_')) {
    if (!isAdmin(from.id)) return;
    const paymentId = data.split('_')[1];
    const payment = db.payments[paymentId];
    if (!payment || payment.status === 'approved') return;
    const user = db.users[String(payment.userId)];
    if (!user) return;

    payment.status = 'approved';
    user.credits += payment.credits;
    saveDb();

    try {
      await bot.sendMessage(payment.userId,
        `✅ Payment approved!\n\n🪙 *${payment.credits} credits* added.\n💼 New balance: *${user.credits}*`,
        { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
      );
    } catch {}

    return bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Approved', callback_data: `done_${paymentId}` }]] }, {
      chat_id: message.chat.id,
      message_id: message.message_id
    }).catch(() => {});
  }

  if (data.startsWith('reject_')) {
    if (!isAdmin(from.id)) return;
    const paymentId = data.split('_')[1];
    const payment = db.payments[paymentId];
    if (!payment) return;
    payment.status = 'rejected';
    saveDb();
    try {
      await bot.sendMessage(payment.userId,
        `❌ Your payment request was cancelled by admin.\n\nFor help contact ${SUPPORT_USERNAME}`,
        { reply_markup: mainKeyboard() }
      );
    } catch {}
    return bot.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ Cancelled', callback_data: `done_${paymentId}` }]] }, {
      chat_id: message.chat.id,
      message_id: message.message_id
    }).catch(() => {});
  }
});

bot.on('message', async (msg) => {
  try {
    if (!msg.from || msg.chat.type !== 'private') return;
    userRecord(msg.from);

    if (isAdmin(msg.from.id)) {
      const replied = await routeAdminReply(msg);
      if (replied) return;
    }

    if (msg.text && msg.text.startsWith('/start')) return;
    if (msg.text && /^\/(balance|buy|field|fileid|setqr|qrstatus)$/.test(msg.text)) return;

    const joined = await ensureJoined(msg.from.id);
    if (!joined) {
      await bot.sendMessage(msg.chat.id, '🚫 First join our group to use this bot.', {
        reply_markup: forceJoinKeyboard(msg.from.id)
      });
      return;
    }

    const user = userRecord(msg.from);

    if (msg.text) {
      const txt = msg.text.trim();

      if (txt === '🪙 Balance') {
        return bot.sendMessage(msg.chat.id,
          `🪙 *Your Balance*

Credits: *${user.credits}*
Referrals: *${user.referrals.length}*`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
        );
      }
      if (txt === '🛒 Buy Credits') {
        setState(msg.from.id, 'await_buy_credits');
        return bot.sendMessage(msg.chat.id,
          `🛒 *Buy Credits*\n\nSend how many credits you want to buy.\n\n💰 Rate: *${CREDITS_PER_RUPEE} credits = ₹1*`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
        );
      }
      if (txt === '🎭 Start FaceSwap') {
        return beginFaceswap(msg.chat.id, msg.from.id);
      }
      if (txt === '👥 Refer & Earn') {
        return bot.sendMessage(msg.chat.id,
          `👥 *Refer & Earn*\n\nInvite link:\n${referralLink(msg.from.id)}\n\n🎁 Earn *${REFERRAL_REWARD} credits* for each valid referral after join + verify.`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
        );
      }
      if (txt === '📜 Rules') {
        return sendRules(msg.chat.id, msg.from.first_name || 'bro');
      }
      if (txt === '🆘 Support') {
        return bot.sendMessage(msg.chat.id,
          `🆘 Need help? Contact ${SUPPORT_USERNAME}`,
          { reply_markup: mainKeyboard() }
        );
      }
      if (txt === '🪙 Balance' || txt === '/balance') {
        return bot.sendMessage(msg.chat.id,
          `🪙 *Your Balance*\n\nCredits: *${user.credits}*\nReferrals: *${user.referrals.length}*`,
          { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
        );
      }

      const handled = await handleTextStates(msg, txt);
      if (handled) return;
    }

    if (msg.photo) {
      if (!isAdmin(msg.from.id)) {
        await notifyAdminsFromUser(msg, '📷 User sent a photo');
      }

      if (user.state === 'await_payment_screenshot') {
        const paymentId = user.temp.paymentId;
        const payment = db.payments[paymentId];
        if (!payment) {
          clearState(msg.from.id);
          return bot.sendMessage(msg.chat.id, '❌ Payment request not found.', { reply_markup: mainKeyboard() });
        }
        payment.screenshotFileId = msg.photo[msg.photo.length - 1].file_id;
        payment.status = 'pending_admin_review';
        saveDb();
        clearState(msg.from.id);
        await bot.sendMessage(msg.chat.id,
          `✅ Screenshot received.

Please wait a few minutes, credits will be added if payment is done.
Any problem contact ${SUPPORT_USERNAME}`,
          { reply_markup: mainKeyboard() }
        );
        await notifyAdminsAboutPaid(payment);
        return;
      }

      if (user.state === 'await_source_photo') {
        setState(msg.from.id, 'await_target_photo', {
          sourceFileId: msg.photo[msg.photo.length - 1].file_id
        });
        return bot.sendMessage(msg.chat.id,
          '📸 Great! Now send the *second photo* for the swap.',
          { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
        );
      }

      if (user.state === 'await_target_photo') {
        const sourceFileId = user.temp.sourceFileId;
        const targetFileId = msg.photo[msg.photo.length - 1].file_id;
        return processSwap(msg.chat.id, msg.from.id, sourceFileId, targetFileId);
      }

      // If user sends a photo without starting, treat it as step 1 for convenience.
      setState(msg.from.id, 'await_target_photo', {
        sourceFileId: msg.photo[msg.photo.length - 1].file_id
      });
      await bot.sendMessage(msg.chat.id,
        '📸 First photo saved.\nNow send the *second photo* to complete FaceSwap.',
        { parse_mode: 'Markdown', reply_markup: mainKeyboard() }
      );
      return;
    }

    if (!isAdmin(msg.from.id)) {
      await notifyAdminsFromUser(msg);
    }
  } catch (e) {
    console.error('message handler error:', e.message);
  }
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log('FaceSwap bot is running...');
