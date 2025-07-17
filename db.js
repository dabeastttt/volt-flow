const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
// Use service role key here for backend write access (don't expose this publicly)
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabase = createClient(supabaseUrl, supabaseServiceRoleKey);

/**
 * Log incoming and outgoing messages (safely truncated)
 */
async function logMessage(phone, incoming, outgoing) {
  const safeIncoming = incoming ? incoming.slice(0, 1000) : null;
  const safeOutgoing = outgoing ? outgoing.slice(0, 1000) : null;

  const { data, error } = await supabase
    .from('messages')
    .insert([{ phone, incoming: safeIncoming, outgoing: safeOutgoing }]);

  if (error) throw error;

  return data[0].id;
}

/**
 * Register tradie record
 */
async function registerTradie(name, business, email, phone) {
  const { data, error } = await supabase
    .from('tradies')
    .insert([{ name, business, email, phone }]);

  if (error) {
    console.error('❌ Supabase insert error:', JSON.stringify(error, null, 2));
    throw new Error(error.message || 'Unknown Supabase error');
  }

  return data?.[0]?.id;
}

/**
 * Get messages for a phone number (latest first)
 */
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

/**
 * Get a customer by phone number
 * Automatically reset `wasIntroduced` to false if older than 30 days
 */
async function getCustomerByPhone(phone) {
  const { data, error } = await supabase
    .from('customers')
    .select('*')
    .eq('phone', phone)
    .single();

  if (error?.message?.includes('Results contain 0 rows')) {
    return null;
  }
  if (error) throw error;

  // Normalize nullable wasIntroduced (null => false)
  const wasIntroduced = data.wasIntroduced ?? false;

  // Reset wasIntroduced if customer record is older than 30 days and wasIntroduced is true
  const createdAt = new Date(data.created_at);
  const daysAgo30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  if (createdAt < daysAgo30 && wasIntroduced) {
    await saveCustomer({ phone, wasIntroduced: false });
    return { ...data, wasIntroduced: false };
  }

  return { ...data, wasIntroduced };
}

/**
 * Save or update a customer (supports partial updates)
 */
async function saveCustomer({ phone, name, wasIntroduced }) {
  const update = { phone };
  if (name !== undefined) update.name = name;
  if (wasIntroduced !== undefined) update.wasIntroduced = wasIntroduced;

  const { data, error } = await supabase
    .from('customers')
    .upsert([update], { onConflict: 'phone' });

  if (error) throw error;

  return data?.[0] || null;
}

/**
 * Generate a summary of today's bookings-related messages
 */
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
    .or(keywords.map(k => `incoming.ilike.%${k}%`).join(','))
    .order('created_at', { ascending: true });

  if (error) {
    console.error('Error fetching bookings summary:', error);
    return '';
  }

  if (!rows || rows.length === 0) return '';

  const uniquePhones = [...new Set(rows.map(row => row.phone))];

  const { data: customers, error: custError } = await supabase
    .from('customers')
    .select('phone, name')
    .in('phone', uniquePhones);

  if (custError) {
    console.error('Error fetching customers:', custError);
    return '';
  }

  const phoneToName = {};
  customers.forEach(c => {
    phoneToName[c.phone] = c.name;
  });

  const summaryLines = rows.map(row => {
    const name = phoneToName[row.phone] || 'Unknown';
    const time = new Date(row.created_at).toLocaleTimeString();

    return `- ${name} (${row.phone}): "${row.incoming.trim()}" at ${time}`;
  });

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

