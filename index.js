require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const { OpenAI } = require('openai');
const twilio = require('twilio');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { logMessage, getMessagesForPhone, registerTradie } = require('./db');

const app = express();
const port = process.env.PORT || 3000;

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

// Middleware
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

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

// 📩 SMS Handler
app.post('/sms', async (req, res) => {
  const incomingMsg = req.body.Body || '';
  const senderRaw = req.body.From || '';
  const sender = formatPhoneNumber(senderRaw);
  let outgoingMsg = '';

  console.log(`SMS from ${sender}: ${incomingMsg}`);

  try {
    // Default tradie number for now — single bot setup
    const tradieNumber = process.env.TRADIE_PHONE_NUMBER || '+61406435844';

    if (/book|schedule|call/i.test(incomingMsg)) {
      outgoingMsg = `Thanks for booking! The sparkie will be in touch soon. Cheers!`;

      await twilioClient.messages.create({
        body: `⚡️ New booking request from ${sender}: "${incomingMsg}"`,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: tradieNumber,
      });

      await twilioClient.messages.create({
        body: outgoingMsg,
        from: process.env.TWILIO_PHONE_NUMBER,
        to: sender,
      });

      await logMessage(sender, incomingMsg, outgoingMsg);
      return res.status(200).send('Booking handled');
    }

    // AI Reply
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        {
          role: 'system',
          content:
            'You are a casual, friendly Aussie sparky assistant. Keep replies short and helpful. Suggest a quote or job booking.',
        },
        { role: 'user', content: incomingMsg },
      ],
    });

    outgoingMsg = completion.choices[0].message.content;
    console.log(`AI reply: ${outgoingMsg}`);

    await twilioClient.messages.create({
      body: outgoingMsg,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: sender,
    });

    await logMessage(sender, incomingMsg, outgoingMsg);
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

  const phone = formatPhoneNumber(phoneRaw);

  try {
    await registerTradie(name, business, email, phone);
    console.log(`✅ Registered: ${name} (${phone})`);

    // Respond early so user isn't waiting
    res.status(200).send('Registered and activated');

    // Then send welcome SMS without blocking
    twilioClient.messages.create({
      body: `⚡️ Welcome to Volt Flow, ${name}! Your AI admin is now active. Messages to this number will be handled automatically.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone,
    }).then(() => {
      console.log(`Welcome SMS sent to ${phone}`);
    }).catch(err => {
      console.error('Error sending welcome SMS:', err);
    });

  } catch (err) {
    console.error('DB error:', err);
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
          <title>Volt Flow Dashboard</title>
          <style>
            body { font-family: sans-serif; padding: 20px; }
            h2 { color: #007acc; }
            table { border-collapse: collapse; width: 100%; }
            th, td { border: 1px solid #ccc; padding: 8px; }
            th { background: #f4f4f4; }
          </style>
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
    console.error(err);
    res.status(500).send('Could not load dashboard');
  }
});

app.listen(port, () => {
  console.log(`⚡️ Volt Flow AI listening on port ${port}`);
});


