const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

const supabase = createClient(supabaseUrl, supabaseAnonKey);

// Log incoming and outgoing messages (safely truncated)
async function logMessage(phone, incoming, outgoing) {
  const safeIncoming = incoming ? incoming.slice(0, 1000) : null;
  const safeOutgoing = outgoing ? outgoing.slice(0, 1000) : null;

  const { data, error } = await supabase
    .from('messages')
    .insert([{ phone, incoming: safeIncoming, outgoing: safeOutgoing }]);

  if (error) throw error;

  return data[0].id;
}

// Register a tradie
async function registerTradie(name, business, email, phone) {
  const { data, error } = await supabase
    .from('tradies')
    .insert([{ name, business, email, phone }]);

  if (error) throw error;

  return data[0].id;
}

// Get messages for a phone number (latest first)
async function getMessagesForPhone(phone, options = {}) {
  const limit = options.limit || 50;

  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) throw error;

  return data;
}

// Get a customer by phone number
async function getCustomerByPhone(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .single();

  if (error && error.code !== 'PGRST116') throw error; // Ignore "no rows" error

  return data || null;
}

// Save or update a customer name by phone (upsert)
async function saveCustomer({ phone, name }) {
  const { data, error } = await supabase
    .from('customers')
    .upsert([{ phone, name }], { onConflict: 'phone' });

  if (error) throw error;

  return data;
}

// Generate a summary of today's messages related to bookings
async function getTodaysBookingsSummary() {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const endOfDay = new Date();
  endOfDay.setHours(23, 59, 59, 999);

  const keywords = [
    'book',
    'booking',
    'schedule',
    'call',
    'quote',
    'job',
    'call back',
    'quoting',
    'ring',
  ];

  const { data: rows, error } = await supabase
    .from('messages')
    .select('phone, incoming, created_at')
    .gte('created_at', startOfDay.toISOString())
    .lte('created_at', endOfDay.toISOString())
    .or(keywords.map((k) => `incoming.ilike.%${k}%`).join(','))
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching bookings summary:', error);
    return '';
  }

  if (!rows || rows.length === 0) return '';

  const summaryLines = await Promise.all(
    rows.map(async (row) => {
      const { data: customer } = await supabase
        .from('customers')
        .select('name')
        .eq('phone', row.phone)
        .single();

      const name = customer?.name || 'Unknown';
      const time = new Date(row.created_at).toLocaleTimeString();

      return `- ${name} (${row.phone}): "${row.incoming.trim()}" at ${time}`;
    })
  );

  return summaryLines.join('\n');
}

module.exports = {
  logMessage,
  registerTradie,
  getMessagesForPhone,
  getCustomerByPhone,
  saveCustomer,
  getTodaysBookingsSummary,
};


