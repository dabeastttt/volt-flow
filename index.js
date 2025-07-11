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
    const customer = await getCustomerByPhone(sender);

    const isBooking = /(book(ing)?|schedule|job)/i.test(incomingMsg);
    const isQuote = /(quote|quoting|how much|cost|price)/i.test(incomingMsg);
    const isCallback = /(call\s?back|ring|talk|speak)/i.test(incomingMsg);
    const isBookingRequest = (isBooking || isQuote || isCallback);

    const callbackTime = '4 pm';
    const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61418723328';

    // 👇 Save name + confirm booking immediately
    if (customer && !customer.name && incomingMsg.split(' ').length <= 3 && incomingMsg.length > 1) {
      await saveCustomer({ phone: sender, name: incomingMsg });
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

    // 👇 Ask for name if it's a booking and we don't know the name yet
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

    // 👇 Confirm booking normally if name already known
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

    // 👇 AI fallback with few-shot examples
    const previousMessages = await getMessagesForPhone(sender, { limit: 5 });

    const messages = [
      {
        role: 'system',
        content: 'You are a casual, friendly Aussie sparky assistant. Keep replies short and helpful. Suggest a quote, job booking or callback.',
      },

      // ✅ FEW-SHOT EXAMPLES
      {
        role: 'user',
        content: 'Hi mate, I need a fan installed.',
      },
      {
        role: 'assistant',
        content: 'No worries! I can get that booked in. Can you send through your name and suburb?',
      },
      {
        role: 'user',
        content: 'What’s the price for downlights?',
      },
      {
        role: 'assistant',
        content: 'Prices vary a bit, but I can sort a quick quote. Mind letting me know how many lights and where you’re based?',
      },
      {
        role: 'user',
        content: 'Can I get someone to come look at a faulty switch?',
      },
      {
        role: 'assistant',
        content: 'Yep, we can help with that. Want me to lock in a callback? Just shoot over your name + suburb.',
      },

      // 👇 Previous messages (if any)
      ...previousMessages.flatMap(msg => [
        { role: 'user', content: msg.incoming },
        { role: 'assistant', content: msg.outgoing },
      ]),

      // 👇 Current incoming message
      { role: 'user', content: incomingMsg },
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages,
    });

    outgoingMsg = completion.choices[0].message.content;
    console.log(`AI reply: ${outgoingMsg}`);

    await twilioClient.messages.create({
      body: outgoingMsg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: sender,
    });

    await logMessage(sender, incomingMsgRaw.slice(0, 500), outgoingMsg.slice(0, 500));
    res.status(200).send('AI handled');
  } catch (err) {
    console.error('Unexpected error:', err);
    res.status(500).send('Internal Server Error');
  }
});

// 📝 Register Tradie
app.post('/register', async (req, res) => {
  const { name, business, email, phone: phoneRaw } = req.body;

  if (!name || !business || !email || !phoneRaw) {
    return res.status(400).send('Missing required fields');
  }

  function formatPhoneNumber(raw) {
    if (!raw || typeof raw !== 'string') return null;

    // Remove spaces, parentheses, dashes
    let cleaned = raw.replace(/[\s\-()]/g, '');

    // If starts with '+', assume international format already
    if (cleaned.startsWith('+')) {
      if (!cleaned.startsWith('+61')) {
        // Optionally reject or handle other country codes here
        return cleaned;
      }
      return cleaned;
    }

    // If starts with 0 (local format), convert to +61
    if (cleaned.startsWith('0')) {
      return '+61' + cleaned.slice(1);
    }

    // Otherwise, add +61 prefix
    return '+61' + cleaned;
  }

  const phone = formatPhoneNumber(phoneRaw);

  try {
    await registerTradie(name, business, email, phone);
    console.log(`✅ Registered: ${name} (${phone})`);

    res.status(200).send('Registered and activated');

    const assistantNumber = process.env.TWILIO_PHONE_NUMBER;

    // Step 1: Welcome
    await twilioClient.messages.create({
      body: `⚡️Hi ${name}, I am your very own assistant that never sleeps. Your AI admin is now active.`,
      from: assistantNumber,
      to: phone,
    });

    // Step 2: Forwarding instructions
    await twilioClient.messages.create({
      body: `📲 Please forward your main mobile number to this AI number (${assistantNumber}) so we can handle missed calls for you. On iPhone/Android, just go to Phone > Settings > Call Forwarding.`,
      from: assistantNumber,
      to: phone,
    });

    // Step 3: Optional tip
    await twilioClient.messages.create({
      body: `Tip: Set forwarding to "When Busy" or "When Unanswered" so we only step in when you're away. You're all set ⚡️`,
      from: assistantNumber,
      to: phone,
    });

    console.log(`✅ Onboarding SMS sent to ${phone}`);
  } catch (err) {
    console.error('DB error:', err?.message || JSON.stringify(err, null, 2));
    if (err && typeof err === 'object') {
      console.error('📄 Full error details:', JSON.stringify(err, null, 2));
    }
    res.status(500).send('Something went wrong');
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
  const callStatus = req.body.CallStatus; // 'no-answer', 'busy', 'completed', etc.
  const fromRaw = req.body.From || '';
  const from = formatPhoneNumber(fromRaw);
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61418723328';

  if (callStatus === 'no-answer' || callStatus === 'busy') {
    const customerMsg = "Hey! Sorry we missed your call. You can book a job, get a quote, or ask a question by replying here. Cheers!";
    const tradieMsg = `⚠️ Missed call from ${from}. Auto-reply sent.`;

    try {
      await twilioClient.messages.create({
        body: customerMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: from,
      });

      await twilioClient.messages.create({
        body: tradieMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: tradieNumber,
      });
    } catch (err) {
      console.error('Error sending missed call SMS:', err);
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


// 🗣️ Voicemail transcription handler
app.post('/voicemail', async (req, res) => {
  const transcription = req.body.TranscriptionText || '';
  const fromRaw = req.body.From || '';
  const from = formatPhoneNumber(fromRaw); // Ensure formatPhoneNumber is defined
  const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61418723328';

  console.log(`🎙️ Voicemail from ${from}: ${transcription}`);

  try {
    // Generate AI reply using OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-3.5-turbo',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful Aussie tradie assistant replying to a voicemail. Keep it short, friendly, and helpful. Offer a callback or a quote.',
        },
        {
          role: 'user',
          content: transcription,
        },
      ],
    });

    const reply = completion.choices[0].message.content;
    console.log(`🤖 AI reply: ${reply}`);

    // Send SMS to the customer
    await twilioClient.messages.create({
      body: reply,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: from,
    });

    // Notify tradie
    await twilioClient.messages.create({
      body: `🎙️ New voicemail from ${from}: "${transcription}"\n\nAI replied: "${reply}"`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: tradieNumber,
    });

    // Optional: log message in local DB
    await logMessage(from, `Voicemail: ${transcription.slice(0, 500)}`, reply.slice(0, 500));

    res.status(200).send('Voicemail handled');
  } catch (err) {
    console.error('❌ Error handling voicemail:', err);
    res.status(500).send('Failed to handle voicemail');
  }
});



const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

app.post('/create-checkout-session', async (req, res) => {
  return res.status(200).json({ url: `${process.env.BASE_URL}/success` });

  /* Stripe logic commented out */
});

// Schedule daily summary SMS to tradie at 3 PM every day
cron.schedule(
  '0 15 * * *',
  async () => {
    try {
      const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61418723328';

      // Get today's bookings/calls/quotes summary text
      const summary = await getTodaysBookingsSummary();

      if (!summary || summary.trim().length === 0) {
        console.log('No bookings or calls today, skipping summary SMS.');
        return;
      }

      await twilioClient.messages.create({
        body: `⚡️ Daily summary:\n${summary}`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: tradieNumber,
      });

      console.log('Sent daily summary SMS to tradie.');
    } catch (err) {
      console.error('Error sending daily summary SMS:', err);
    }
  },
  {
    timezone: 'Australia/Sydney',
  }
);

app.listen(port, () => {
  console.log(`⚡️ AI Apprentice listening on port ${port}`);
}); 

