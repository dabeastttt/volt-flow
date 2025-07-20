require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const path = require('path');
const {
  logMessage,
  getMessagesForPhone,
  registerTradie,
  getTodaysBookingsSummary,
  getCustomerByPhone,
  saveCustomer,
} = require('./db');
const cron = require('node-cron');

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

const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61497074904';
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


// 📊 View dashboard (basic HTML)
app.get('/dashboard', async (req, res) => {
  const { phone: phoneRaw } = req.query;

  if (!phoneRaw) return res.status(400).send('Phone number required');

  const phone = formatPhoneNumber(phoneRaw);

  try {
    const messages = await getMessagesForPhone(phone);

    const html = `
      <html>
        <head>
          <title>TradeAssist A.I Dashboard</title>
        </head>
        <body>
          <h2>Message History for ${phone}</h2>
          <table>
            <tr><th>Time</th><th>Incoming</th><th>Reply</th></tr>
            ${messages
              .map(
                (msg) =>
                  `<tr><td>${msg.created_at}</td><td>${msg.incoming}</td><td>${msg.outgoing}</td></tr>`
              )
              .join('')}
          </table>
        </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    console.error('Error loading dashboard:', err);
    res.status(500).send('Error loading dashboard');
  }
});

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

app.post('/voicemail', async (req, res) => {
  const transcription = req.body.TranscriptionText || '';
  const fromRaw = req.body.From || '';
  const from = formatPhoneNumber(fromRaw);
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER;

  console.log(`🎙️ Voicemail from ${from}: ${transcription}`);

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

    // 7. Log the exchange
    await logMessage(from, `Voicemail: ${transcription.slice(0, 500)}`, reply.slice(0, 500));
    console.log(`📦 Logged message to DB`);

    return res.status(200).send('Voicemail processed');
  } catch (err) {
    console.error('❌ Final error in voicemail handler:', err);
    return res.status(500).send('Voicemail handling failed');
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});


