require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { saveVoicemail } = require('./db');
const {
  logMessage,
  getMessagesForPhone,
  registerTradie,
  getTodaysBookingsSummary,
  getCustomerByPhone,
  saveCustomer,
} = require('./db');
const cron = require('node-cron');

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);


const app = express();
const port = process.env.PORT || 10000;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const INTRO_MESSAGE = `Hey mate, I’m currently on the tools but I’m handing you to my AI assistant. You can book a job, get a quote, or ask a question by replying here. Leave your name and contact details and I’ll get back to you.`;

// Helper: Format phone number to E.164 for Australia (+61)
function formatPhoneNumber(phone) {
  if (!phone) return phone;
  let digits = phone.replace(/\D/g, ''); // Remove non-digits

  // If Australian mobile number starts with 0 and is 10 digits
  if (digits.length === 10 && digits.startsWith('0')) {
    return '+61' + digits.slice(1);
  }

  // If already starts with +, assume correct format
  if (phone.startsWith('+')) {
    return phone;
  }

  // Otherwise, return original (you might want to expand this for other cases)
  return phone;
}

function isLowIntentMessage(message) {
  const trimmed = message.trim().toLowerCase();
  const lowIntentReplies = [
    'ok', 'okay', 'thanks', 'thank you', 'cool',
    '👍', '👌', 'great', 'no worries', 'cheers', 'got it',
    'sounds good', 'roger', 'yep', 'yup', 'aye', 'k', 'sure',
  ];
  return lowIntentReplies.includes(trimmed) || trimmed.length < 3;
}

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve success.html at /success (optional because it’s already in public)
app.get('/success', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'success.html'));
});

// Rate limiter: max 5 requests per minute per phone number or IP
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.body.From || req.ip,
  handler: (req, res) => {
    return res.status(429).send('Too many requests, please try again later.');
  },
});
app.use('/sms', limiter);

const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61406435844';
const callbackTime = '4 pm';

// MAIN SMS INBOUND HANDLER
app.post('/sms', async (req, res) => {
  const incomingMsgRaw = req.body.Body || '';
  const incomingMsg = incomingMsgRaw.trim();
  const senderRaw = req.body.From || '';
  const sender = formatPhoneNumber(senderRaw);

  if (isLowIntentMessage(incomingMsg)) {
    console.log(`👋 Low intent message from ${sender}: "${incomingMsg}" - Ignoring.`);
    return res.status(200).send('Low intent message ignored');
  }

  let outgoingMsg = '';
  console.log(`SMS from ${sender}: ${incomingMsg}`);

  try {
    let customer = await getCustomerByPhone(sender);
    const isNewCustomer = !customer;
    const isBooking = /(book(ing)?|schedule|job)/i.test(incomingMsg);
    const isQuote = /(quote|quoting|how much|cost|price)/i.test(incomingMsg);
    const isCallback = /(call\s?back|ring|talk|speak)/i.test(incomingMsg);
    const isBookingRequest = isBooking || isQuote || isCallback;

    // Determine if re-introduction is needed
    let needsIntro = false;

    if (!customer) {
      needsIntro = true;
    } else {
      const lastIntro = new Date(customer.created_at);
      const now = new Date();
      const daysSinceIntro = Math.floor((now - lastIntro) / (1000 * 60 * 60 * 24));
      if (!customer.wasIntroduced || daysSinceIntro >= 30) {
        needsIntro = true;
      }
    }

    if (needsIntro) {
      outgoingMsg = `Hey mate, I’m currently on the tools but I’m handing you to my AI assistant. You can book a job, get a quote, or ask a question by replying here. Leave your name and contact details and I’ll get back to you.`;

      await twilioClient.messages.create({
        body: outgoingMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sender,
      });

      if (customer) {
        await saveCustomer({ ...customer, wasIntroduced: true });
      } else {
        await saveCustomer({ phone: sender, wasIntroduced: true });
      }

      await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
      return res.status(200).send('AI assistant intro sent');
    }

    // 👇 Save name if not already saved
    if (customer && !customer.name && incomingMsg.split(' ').length <= 3 && incomingMsg.length > 1) {
      await saveCustomer({ ...customer, phone: sender, name: incomingMsg });
      const customerName = incomingMsg;

      outgoingMsg = `Thanks for booking, ${customerName}! The sparkie will call you back at ${callbackTime}. Cheers!`;

      await twilioClient.messages.create({
        body: outgoingMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sender,
      });

      await twilioClient.messages.create({
        body: `⚡️ New request from ${customerName} (${sender}): "${incomingMsgRaw}". Will call back at ${callbackTime}.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: tradieNumber,
      });

      await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
      return res.status(200).send('Saved customer name and confirmed booking');
    }

    // Ask for name if it's a booking request and no name known
    if (isBookingRequest && (!customer || !customer.name)) {
      outgoingMsg = "Hi! To help with your request, could you please reply with your full name?";

      await twilioClient.messages.create({
        body: outgoingMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sender,
      });

      await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
      return res.status(200).send('Asked for customer name');
    }

    // Confirm booking if name is known
    if (isBookingRequest && customer?.name) {
      const customerName = customer.name;

      outgoingMsg = `Thanks for your request, ${customerName}! The sparkie will call you back at ${callbackTime}. Cheers!`;

      await twilioClient.messages.create({
        body: outgoingMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sender,
      });

      await twilioClient.messages.create({
        body: `⚡️ New request from ${customerName} (${sender}): "${incomingMsgRaw}". Will call back at ${callbackTime}.`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: tradieNumber,
      });

      await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
      return res.status(200).send('Booking handled');
    }

    // Else fallback to OpenAI assistant
    return await handleWithAI(incomingMsgRaw, sender, res);
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// FALLBACK AI HANDLER FUNCTION
async function handleWithAI(incomingMsgRaw, sender, res) {
  try {
    const incomingMsg = incomingMsgRaw.trim();
    const tradieType = await getTradieType(sender); // 'electrician', 'plumber', etc.
    const previousMessages = await getMessagesForPhone(sender, { limit: 5 });

    const toneMap = {
      electrician: 'You are a casual, friendly Aussie sparky assistant. Keep replies short and helpful. Suggest a quote, job booking or callback.',
      plumber: 'You are a casual, friendly Aussie plumbing assistant. Keep replies short and helpful. Suggest a quote, job booking or callback.',
      carpenter: 'You are a casual, friendly Aussie carpentry assistant. Keep replies short and helpful. Suggest a quote, job booking or callback.',
    };

    const examplesMap = {
      electrician: [
        { role: 'user', content: 'Hi mate, I need a fan installed.' },
        { role: 'assistant', content: 'No worries! I can get that booked in. Can you send through your name and suburb?' },
        { role: 'user', content: 'What’s the price for downlights?' },
        { role: 'assistant', content: 'Prices vary a bit, but I can sort a quick quote. Mind letting me know how many lights and where you’re based?' },
      ],
      plumber: [
        { role: 'user', content: 'Pipe’s leaking under the sink.' },
        { role: 'assistant', content: 'Yikes! Let’s get that sorted quick. Can you send me your name + where you’re located?' },
      ],
      carpenter: [
        { role: 'user', content: 'Can you build a deck?' },
        { role: 'assistant', content: 'Absolutely. Just need your name and suburb to give you a proper quote.' },
      ]
    };

    const systemMessage = toneMap[tradieType] || 'You are a helpful Aussie trades assistant. Keep things short, casual, and ask for name + location to follow up.';
    const examples = examplesMap[tradieType] || [];

    const messages = [
      { role: 'system', content: systemMessage },
      ...examples,
      ...previousMessages.flatMap(msg => [
        { role: 'user', content: msg.incoming },
        { role: 'assistant', content: msg.outgoing },
      ]),
      { role: 'user', content: incomingMsg }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
    });

    const outgoingMsg = completion.choices[0].message.content;
    console.log(`🤖 AI reply: ${outgoingMsg}`);

    await twilioClient.messages.create({
      body: outgoingMsg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: sender,
    });

    await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
    return res.status(200).send('AI handled');
  } catch (err) {
    console.error('AI fallback error:', err);
    res.status(500).send('Internal Server Error');
  }
}
//tradie register
app.post('/register', async (req, res) => {
  console.log('➡️ Incoming /register request');
  console.log('📦 Request body:', req.body);

  const { name, business, email, phoneRaw } = req.body;

  if (!name || !business || !email || !phoneRaw) {
    console.log('❌ Missing required fields:', { name, business, email, phoneRaw });
    return res.status(400).send('Missing required fields');
  }

  function formatPhoneNumber(raw) {
    if (!raw || typeof raw !== 'string') return null;
    let cleaned = raw.replace(/[\s\-()]/g, '');
    if (cleaned.startsWith('+')) return cleaned;
    if (cleaned.startsWith('0')) return '+61' + cleaned.slice(1);
    return '+61' + cleaned;
  }

  const phone = formatPhoneNumber(phoneRaw);
  console.log('📱 Formatted phone:', phone);

  try {
    console.log('🧠 Calling registerTradie...');
    await registerTradie(name, business, email, phone);
    console.log(`✅ Registered tradie: ${name} (${phone})`);

    const assistantNumber = process.env.TWILIO_PHONE_NUMBER;
    if (!assistantNumber) {
      console.error('❌ TWILIO_PHONE_NUMBER is not set in environment variables');
      return res.status(500).send('Server config error: Twilio number missing');
    }
    console.log('📞 Twilio assistant number:', assistantNumber);

    // Send onboarding SMSs
    const sms1 = await twilioClient.messages.create({
      body: `⚡️Hi ${name}, I am your very own 24/7✅ assistant that never sleeps. Your AI admin is now active.`,
      from: assistantNumber,
      to: phone,
    });
    console.log('📤 SMS 1 sent:', sms1.sid);

    const sms2 = await twilioClient.messages.create({
      body: `📲 Please forward your main mobile number to this AI number (${assistantNumber}) so we can handle missed calls for you.`,
      from: assistantNumber,
      to: phone,
    });
    console.log('📤 SMS 2 sent:', sms2.sid);

    const sms3 = await twilioClient.messages.create({
      body: `Tip: Set forwarding to "When Busy" or "When Unanswered" so we only step in when you're away. You're all set ⚡️`,
      from: assistantNumber,
      to: phone,
    });
    console.log('📤 SMS 3 sent:', sms3.sid);

    console.log(`✅ All onboarding SMS sent to ${phone}`);

    // Success
    return res.status(200).json({ success: true });

  } catch (err) {
    console.error('❗ Error in /register route:', err.message || err);
    if (err.stack) console.error(err.stack);
    return res.status(500).send('Something went wrong');
  }
});

// 📥 Simple Login Page
app.get('/dashboard', (req, res) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" /> 
  <title>TradeAssist A.I — Login</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #0A0A0A;
      color: #FFFFFF;
      overflow-x: hidden;
      height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      position: relative;
    }

    #matrixCanvas {
      position: fixed;
      top: 0; left: 0;
      width: 100%; height: 100%;
      z-index: 0;
      background: #0A0A0A;
    }

    main {
      position: relative;
      z-index: 10;
      background: #1E1E1E;
      padding: 2rem 1.5rem;
      border-radius: 16px;
      box-shadow:
       0 0 12px 2px rgba(255, 145, 77, 0.4),
       0 0 20px 4px rgba(255, 107, 0, 0.25);
      text-align: center;
      width: 90%;
      max-width: 340px;
      color: #FFFFFF;
      font-family: inherit;
      margin: auto;
      box-sizing: border-box;
    }

    .glow-icon {
      width: 120px;
      height: 120px;
      margin-bottom: 1rem;
      filter: drop-shadow(0 0 12px #FF6B00);
    }

    h1 {
      margin-bottom: 1.5rem;
      text-shadow: 0 0 10px #FF914Dbb;
      color: #FF6B00;
      font-weight: 900;
      font-size: 2rem;
    }

    input[type="tel"] {
      padding: 0.75rem 1rem;
      border-radius: 10px;
      border: 2px solid #FF6B00;
      width: 100%;
      margin-bottom: 1.5rem;
      font-size: 1rem;
      box-sizing: border-box;
      background-color: #1E1E1E;
      color: #FFFFFF;
      box-shadow: 0 0 8px 3px #FF6B00;
      transition: border-color 0.3s ease, box-shadow 0.3s ease, background-color 0.3s ease;
    }

    input[type="tel"]:focus {
      outline: none;
      border-color: #FF914D;
      box-shadow: 0 0 12px 4px #FF914D;
      background-color: #2a2a2a;
    }

    button {
      width: 100%;
      padding: 0.9rem;
      font-size: 1.2rem;
      font-weight: 700;
      background: #FF6B00;
      color: #0A0A0A;
      border: none;
      border-radius: 12px;
      cursor: pointer;
      box-shadow: 0 6px 16px #FF6B0088;
      transition: background 0.3s ease, color 0.3s ease, box-shadow 0.3s ease;
      margin-top: 1rem;
    }

    button:hover,
    button:focus {
      background: #FF914D;
      color: #FFFFFF;
      box-shadow: 0 8px 20px #FF6B0099;
      outline: none;
    }
  </style>
</head>
<body>
  <canvas id="matrixCanvas"></canvas>

  <main>
    <svg class="glow-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <defs>
        <linearGradient id="orangeBolt" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FF6B00" />
          <stop offset="100%" stop-color="#FF914D" />
        </linearGradient>
      </defs>
      <path d="M32 8c-11 0-20 9-20 20v4c0 2.2 1.8 4 4 4h32c2.2 0 4-1.8 4-4v-4c0-11-9-20-20-20z"
            fill="url(#orangeBolt)" stroke="#FFFFFF" stroke-width="2"/>
      <path d="M20 36v-4c0-6.6 5.4-12 12-12s12 5.4 12 12v4"
            fill="none" stroke="#FFFFFF" stroke-width="2"/>
    </svg>

    <h1>Enter Your Phone Number</h1>
    <form action="/dashboard/view" method="GET" autocomplete="off">
      <input type="tel" name="phone" pattern="[0-9\\s]+" placeholder="0400 000 000" required />
      <button type="submit">View Dashboard</button>
    </form>
  </main>

<script>
  const canvas = document.getElementById('matrixCanvas');
  const ctx = canvas.getContext('2d');
  const fontSize = 20;
  let columns, drops;

  const symbols = [
    '⊗', '⛏', '⚒', '⛓', '🛠', '🗜', '⚙', '⛭',
    '✚', '╬', '♯', '†', '☗', '╧',
    '#', '%', '&', '*', '+', '=', '-', '|', '/', '\\'
  ];

  function initMatrix() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    columns = Math.floor(canvas.width / fontSize);
    drops = Array(columns).fill(1);
  }

  function drawMatrix() {
    ctx.fillStyle = 'rgba(10, 10, 10, 0.05)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#FF6B00';
    ctx.font = fontSize + 'px monospace';

    for (let i = 0; i < columns; i++) {
      const symbol = symbols[Math.floor(Math.random() * symbols.length)];
      ctx.fillText(symbol, i * fontSize, drops[i] * fontSize);

      if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
        drops[i] = 0;
      }
      drops[i]++;
    }

    requestAnimationFrame(drawMatrix);
  }

  window.addEventListener('resize', initMatrix);
  window.onload = () => {
    initMatrix();
    drawMatrix();
  };
</script>
</body>
</html>`;
  res.send(html);
});


// 📊 View dashboard (mobile-friendly HTML)
app.get('/dashboard/view', async (req, res) => {
  const { phone: phoneRaw } = req.query;
  if (!phoneRaw) return res.status(400).send('Phone number required');

  const phone = formatPhoneNumber(phoneRaw);
  const escapeHTML = str => str.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
  })[c]);

  try {
    const { data: messages } = await supabase
      .from('messages')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false });

    const { data: voicemails } = await supabase
      .from('voicemails')
      .select('*')
      .eq('phone', phone)
      .order('created_at', { ascending: false });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>TradeAssist A.I Dashboard</title>
  <style>
    body, html {
      margin: 0;
      padding: 0;
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #0A0A0A;
      color: #FF914D;
      overflow-x: hidden;
      min-height: 100vh;
    }

    .glow-icon {
      width: 120px;
      height: 120px;
      margin: 0 auto 1rem auto;
      display: block;
      filter: drop-shadow(0 0 10px #FF6B00);
    }

    #matrixCanvas {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      z-index: 0;
      background: #0A0A0A;
    }

    main {
      position: relative;
      z-index: 10;
      width: 90%;
      max-width: 960px;
      margin: 2rem auto;
      background: #1E1E1E;
      border-radius: 16px;
      box-shadow: 0 0 20px #FF914D99;
      padding: 1.5rem;
      box-sizing: border-box;
    }

    h2 {
      color: #FF6B00;
      text-align: center;
      margin-bottom: 1rem;
      text-shadow: 0 0 10px #FF914Dbb;
    }

    .table-container {
      width: 100%;
      overflow-x: auto;
      margin-bottom: 2rem;
    }

    table {
      width: 100%;
      border-collapse: collapse;
      color: #FF914D;
      table-layout: fixed;
      word-wrap: break-word;
    }

    th, td {
      border: 1px solid #FF6B00;
      padding: 8px;
      text-align: left;
      vertical-align: top;
      word-break: break-word;
    }

    th {
      background: #2a2a2a;
      color: #FF6B00;
    }

    tr:nth-child(even) {
      background-color: rgba(255, 145, 77, 0.05);
    }

    audio {
      width: 100%;
    }

    @media (max-width: 600px) {
      main {
        width: 95%;
        padding: 1rem;
        margin: 1.5rem auto;
      }

      th, td {
        font-size: 0.85rem;
      }

      .glow-icon {
        width: 80px;
        height: 80px;
      }
    }
  </style>
</head>
<body>
  <canvas id="matrixCanvas"></canvas>
  <main>
    <svg class="glow-icon" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="orangeBolt" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#FF6B00" />
          <stop offset="100%" stop-color="#FF914D" />
        </linearGradient>
      </defs>
      <path d="M32 8c-11 0-20 9-20 20v4c0 2.2 1.8 4 4 4h32c2.2 0 4-1.8 4-4v-4c0-11-9-20-20-20z"
            fill="url(#orangeBolt)" stroke="#FFFFFF" stroke-width="2"/>
      <path d="M20 36v-4c0-6.6 5.4-12 12-12s12 5.4 12 12v4"
            fill="none" stroke="#FFFFFF" stroke-width="2"/>
    </svg>

    <h2>📨 Message History for ${escapeHTML(phone)}</h2>
    <div class="table-container">
      <table>
        <tr><th>Time</th><th>Incoming</th><th>Reply</th></tr>
        ${
          messages?.length
            ? messages.map(msg =>
                `<tr>
                  <td>${msg.created_at || '—'}</td>
                  <td>${escapeHTML(msg.incoming || '—')}</td>
                  <td>${escapeHTML(msg.outgoing || '—')}</td>
                </tr>`
              ).join('')
            : '<tr><td colspan="3">No messages found.</td></tr>'
        }
      </table>
    </div>

    <h2>🎧 Voicemail Log</h2>
    <div class="table-container">
      <table>
        <tr><th>Time</th><th>Audio</th><th>Transcript</th><th>AI Reply</th></tr>
        ${
          voicemails?.length
            ? voicemails.map(vm =>
                `<tr>
                  <td>${vm.created_at || '—'}</td>
                  <td>${vm.recording_url ? `<audio controls src="${vm.recording_url}"></audio>` : 'No audio'}</td>
                  <td>${escapeHTML(vm.transcription || '—')}</td>
                  <td>${escapeHTML(vm.ai_reply || '—')}</td>
                </tr>`
              ).join('')
            : '<tr><td colspan="4">No voicemails found.</td></tr>'
        }
      </table>
    </div>
  </main>

  <script>
    const canvas = document.getElementById('matrixCanvas');
    const ctx = canvas.getContext('2d');
    const fontSize = 20;
    let columns, drops;

    const symbols = [
      '⊗', '⛏', '⚒', '⛓', '🛠', '🗜', '⚙', '⛭',
      '✚', '╬', '♯', '†', '☗', '╧',
      '#', '%', '&', '*', '+', '=', '-', '|', '/', '\\'
    ];

    function initMatrix() {
      canvas.width = window.innerWidth;
      canvas.height = window.innerHeight;
      columns = Math.floor(canvas.width / fontSize);
      drops = Array(columns).fill(1);
    }

    function drawMatrix() {
      ctx.fillStyle = 'rgba(10, 10, 10, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#FF6B00';
      ctx.font = fontSize + 'px monospace';

      for (let i = 0; i < columns; i++) {
        const symbol = symbols[Math.floor(Math.random() * symbols.length)];
        ctx.fillText(symbol, i * fontSize, drops[i] * fontSize);

        if (drops[i] * fontSize > canvas.height && Math.random() > 0.975) {
          drops[i] = 0;
        }
        drops[i]++;
      }

      requestAnimationFrame(drawMatrix);
    }

    window.addEventListener('resize', initMatrix);
    window.onload = () => {
      initMatrix();
      drawMatrix();
    };
  </script>
</body>
</html>`;

    res.send(html);
  } catch (error) {
    console.error(error);
    res.status(500).send('Internal server error');
  }
});

//call back
app.post('/call-status', async (req, res) => {
  const callStatus = req.body.CallStatus; // 'no-answer', 'busy', etc.
  const fromRaw = req.body.From || '';
  const from = formatPhoneNumber(fromRaw);
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;
  const introMsg = INTRO_MESSAGE;
  const tradieMsg = `⚠️ Missed call from ${from}. Auto‑reply sent.`;

  if (['no-answer', 'busy'].includes(callStatus)) {
    try {
      // Check if intro message was recently sent
      const lastMsg = await getLastMessage(from);
      const now = new Date();
      const lastSent = new Date(lastMsg?.created_at || 0);
      const minsSince = (now - lastSent) / (1000 * 60);

      if (minsSince < 15 && lastMsg?.outgoing === introMsg) {
        console.log(`⏳ Intro message recently sent to ${from}. Skipping.`);
        return res.status(200).send('Intro recently sent. Skipping.');
      }

      // 1. Send intro SMS to customer
      await twilioClient.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE_NUMBER, to: from });
      // 2. Notify tradie
      await twilioClient.messages.create({ body: tradieMsg, from: process.env.TWILIO_PHONE_NUMBER, to: tradieNumber });
      // 3. Log message in DB
      await logMessage(from, 'Missed call auto-reply', introMsg);

      // 4. Mark customer as introduced
      const customer = await getCustomerByPhone(from);
      if (!customer) {
        await saveCustomer({ phone: from, wasIntroduced: true });
      } else if (!customer.wasIntroduced) {
        await saveCustomer({ ...customer, wasIntroduced: true });
      }

      console.log(`✅ Intro sent to ${from}`);
    } catch (err) {
      console.error('❌ Error handling missed call:', err);
    }
  }

  res.status(200).send('Call status processed');
});

// ☎️ Incoming voice call - lets caller leave a voicemail
app.post('/voice', (req, res) => {
  const response = new twilio.twiml.VoiceResponse();

  response.say("Hi there! The tradie is currently unavailable. Please leave a message after the beep and we'll get back to you shortly.");

  response.record({
    maxLength: 60, // seconds
    playBeep: true,
    transcribe: true,
    transcribeCallback: 'https://volt-flow.onrender.com/voicemail', // Twilio will call this with the transcription
    action: 'https://volt-flow.onrender.com/voicemail', // fallback if transcription fails
  });

  response.hangup();

  res.type('text/xml');
  res.send(response.toString());
});


//voicemail
app.post('/voicemail', async (req, res) => {
  const rawRecordingUrl = req.body.RecordingUrl || '';
  const recording_url = rawRecordingUrl ? `${rawRecordingUrl}.mp3` : '';
  const fromRaw = req.body.From || '';
  const from = formatPhoneNumber(fromRaw);
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  console.log(`🎙️ Voicemail from ${from}: ${transcription}`);
  console.log(`🔗 Recording URL: ${recording_url}`);

  const introMsg = INTRO_MESSAGE;
  let reply = '';

  try {
    // 1. Send intro SMS
    await twilioClient.messages.create({ body: introMsg, from: process.env.TWILIO_PHONE_NUMBER, to: from });
    console.log(`✅ Sent intro to ${from}`);

    // 2. Flag introduction in DB
    const customer = await getCustomerByPhone(from);
    if (!customer) {
      await saveCustomer({ phone: from, wasIntroduced: true });
      console.log(`💾 New customer saved: ${from}`);
    } else if (!customer.wasIntroduced) {
      await saveCustomer({ phone: from, wasIntroduced: true });
      console.log(`📝 Updated intro status for ${from}`);
    }

    // 3. Small delay to avoid race conditions
    await new Promise(r => setTimeout(r, 3000));

    // 4. AI reply generation
    try {
      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'You are a helpful Aussie tradie assistant replying to voicemail...' },
          { role: 'user', content: transcription },
        ],
      });

      reply = response.choices?.[0]?.message?.content?.trim() || '';

      if (!reply) {
        console.warn('⚠️ OpenAI returned no reply. Skipping AI response.');
        return res.status(200).send('No AI reply generated');
      }

      console.log(`🤖 AI reply: ${reply}`);
    } catch (openaiError) {
      console.error('❌ OpenAI error:', openaiError?.message || openaiError);
      return res.status(500).send('OpenAI failed');
    }

    // 5. Send AI reply to customer
    await twilioClient.messages.create({ body: reply, from: process.env.TWILIO_PHONE_NUMBER, to: from });
    console.log(`✅ Sent AI reply to ${from}`);

    // 6. Notify tradie
    await twilioClient.messages.create({
      body: `🎙️ Voicemail from ${from}: "${transcription}"\n\nAI replied: "${reply}"`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: tradieNumber,
    });
    console.log(`✅ Alerted tradie at ${tradieNumber}`);

    // 7. Log to messages
    await logMessage(from, `Voicemail: ${transcription.slice(0, 500)}`, reply.slice(0, 500));
    console.log(`📦 Logged message to DB`);

    // 8. Save voicemail record with recording URL
    await saveVoicemail({
      phone: from,
      transcription,
      ai_reply: reply,
      recording_url, // ✅ Save this in Supabase
    });
    console.log('💾 Voicemail saved to Supabase');

    return res.status(200).send('Voicemail processed');
  } catch (err) {
    console.error('❌ Final error in voicemail handler:', err);
    return res.status(500).send('Voicemail handling failed');
  }
});

// Your app listen block, outside the route handlers:
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
