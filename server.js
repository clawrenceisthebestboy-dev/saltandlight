require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const bcrypt = require('bcrypt');
const cron = require('node-cron');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

// DB setup
const db = new Database(path.join(__dirname, 'saltandlight.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    station TEXT NOT NULL,
    date TEXT NOT NULL,
    time TEXT NOT NULL,
    available INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, email TEXT,
    station TEXT, date TEXT, time TEXT,
    notes TEXT, status TEXT DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS clients (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, phone TEXT, email TEXT UNIQUE,
    waiver_signed_at TEXT, waiver_expires_at TEXT,
    waiver_ip TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS intake_forms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id INTEGER, issues TEXT, pain_level INTEGER,
    goals TEXT, consent INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS testimonials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, message TEXT, rating INTEGER,
    approved INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS blocked_dates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT UNIQUE, reason TEXT
  );
`);

// Admin auth
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'saltlight2024';
const sessions = new Set();

// Email transporter
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: 587,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) return;
  try {
    await mailer.sendMail({ from: `Salt & Light Wellness <${process.env.SMTP_USER}>`, to, subject, html });
  } catch(e) { console.log('Email error:', e.message); }
}

function emailTemplate(title, body) {
  return `<div style="font-family:Georgia,serif;max-width:600px;margin:0 auto;background:#fffdf9;padding:40px">
    <div style="text-align:center;margin-bottom:30px"><h1 style="color:#c9a96e;font-size:24px">Salt & Light Wellness</h1></div>
    <h2 style="color:#2c2420">${title}</h2>${body}
    <hr style="border-color:#e8ddd5;margin:30px 0">
    <p style="color:#6b4c3b;font-size:13px">📍 North Conway, NH &nbsp;|&nbsp; ⚠️ Prices shown are cash pricing. Card payments incur a 3.5% processing fee.</p>
  </div>`;
}

// API Routes

// Get available slots
app.get('/api/slots', (req, res) => {
  const { station, date } = req.query;
  if (!station || !date) return res.json([]);
  const day = new Date(date).getDay();
  if (day === 0) return res.json([]); // Closed Sundays
  const blocked = db.prepare('SELECT id FROM blocked_dates WHERE date=?').get(date);
  if (blocked) return res.json([]);
  const slots = db.prepare('SELECT * FROM slots WHERE station=? AND date=? AND available=1').all(station, date);
  res.json(slots);
});

// Create reservation
app.post('/api/book', async (req, res) => {
  const { name, phone, email, station, date, time, notes } = req.body;
  if (!name || !email || !station || !date || !time) return res.status(400).json({ error: 'Missing fields' });

  // Check slot still available
  const slot = db.prepare('SELECT * FROM slots WHERE station=? AND date=? AND time=? AND available=1').get(station, date, time);
  if (!slot) return res.status(409).json({ error: 'Slot no longer available' });

  // Mark slot taken
  db.prepare('UPDATE slots SET available=0 WHERE id=?').run(slot.id);

  // Save reservation
  const result = db.prepare('INSERT INTO reservations (name,phone,email,station,date,time,notes) VALUES (?,?,?,?,?,?,?)').run(name, phone, email, station, date, time, notes || '');

  // Check if client needs waiver
  const client = db.prepare('SELECT * FROM clients WHERE email=?').get(email);
  const needsWaiver = !client || !client.waiver_signed_at || new Date(client.waiver_expires_at) < new Date();

  // Send confirmation email
  await sendEmail(email, 'Reservation Confirmed — Salt & Light Wellness', emailTemplate('Your Reservation is Confirmed!', `
    <p>Hi ${name},</p>
    <p>Your reservation has been confirmed. See you soon!</p>
    <table style="background:#f5ede0;padding:20px;border-radius:8px;width:100%">
      <tr><td><strong>Service:</strong></td><td>${station}</td></tr>
      <tr><td><strong>Date:</strong></td><td>${date}</td></tr>
      <tr><td><strong>Time:</strong></td><td>${time}</td></tr>
    </table>
    <p style="background:#fff3cd;padding:15px;border-radius:8px;margin-top:20px">💰 <strong>Payment is collected in person.</strong> Cash prices shown; card adds 3.5% processing fee.</p>
    ${needsWaiver ? '<p>⚠️ Please complete your waiver before your appointment: <a href="https://saltandlight.com/waiver">Sign Waiver</a></p>' : ''}
  `));

  res.json({ success: true, reservationId: result.lastInsertRowid, needsWaiver });
});

// Save waiver
app.post('/api/waiver', (req, res) => {
  const { name, email, phone, signature, ip } = req.body;
  const now = new Date().toISOString();
  const expires = new Date(Date.now() + 365*24*60*60*1000).toISOString();

  const existing = db.prepare('SELECT id FROM clients WHERE email=?').get(email);
  if (existing) {
    db.prepare('UPDATE clients SET waiver_signed_at=?, waiver_expires_at=?, waiver_ip=? WHERE email=?').run(now, expires, ip, email);
  } else {
    db.prepare('INSERT INTO clients (name,phone,email,waiver_signed_at,waiver_expires_at,waiver_ip) VALUES (?,?,?,?,?,?)').run(name, phone, email, now, expires, ip);
  }
  res.json({ success: true, expires });
});

// Check waiver status
app.get('/api/waiver-status', (req, res) => {
  const { email } = req.query;
  const client = db.prepare('SELECT * FROM clients WHERE email=?').get(email);
  if (!client || !client.waiver_signed_at) return res.json({ needsWaiver: true });
  const expired = new Date(client.waiver_expires_at) < new Date();
  res.json({ needsWaiver: expired, expiresAt: client.waiver_expires_at });
});

// Save intake form
app.post('/api/intake', (req, res) => {
  const { email, issues, pain_level, goals, consent } = req.body;
  const client = db.prepare('SELECT id FROM clients WHERE email=?').get(email);
  if (!client) return res.status(404).json({ error: 'Client not found' });
  db.prepare('INSERT INTO intake_forms (client_id,issues,pain_level,goals,consent) VALUES (?,?,?,?,?)').run(client.id, JSON.stringify(issues), pain_level, goals, consent ? 1 : 0);
  res.json({ success: true });
});

// Submit testimonial
app.post('/api/testimonial', (req, res) => {
  const { name, message, rating } = req.body;
  db.prepare('INSERT INTO testimonials (name,message,rating) VALUES (?,?,?)').run(name, message, rating || 5);
  res.json({ success: true });
});

// Get approved testimonials
app.get('/api/testimonials', (req, res) => {
  res.json(db.prepare('SELECT * FROM testimonials WHERE approved=1 ORDER BY created_at DESC').all());
});

// ===== ADMIN ROUTES =====
function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !sessions.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASS) return res.status(401).json({ error: 'Wrong password' });
  const token = Math.random().toString(36).slice(2) + Date.now();
  sessions.add(token);
  res.json({ token });
});

app.get('/api/admin/reservations', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT * FROM reservations ORDER BY date,time').all());
});

app.get('/api/admin/clients', adminAuth, (req, res) => {
  res.json(db.prepare('SELECT c.*,i.issues,i.pain_level,i.goals FROM clients c LEFT JOIN intake_forms i ON c.id=i.client_id ORDER BY c.created_at DESC').all());
});

app.post('/api/admin/slots', adminAuth, (req, res) => {
  const { station, date, time } = req.body;
  const day = new Date(date).getDay();
  if (day === 0) return res.status(400).json({ error: 'Closed Sundays' });
  db.prepare('INSERT OR IGNORE INTO slots (station,date,time) VALUES (?,?,?)').run(station, date, time);
  res.json({ success: true });
});

app.delete('/api/admin/slots/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM slots WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/block', adminAuth, (req, res) => {
  const { date, reason } = req.body;
  db.prepare('INSERT OR REPLACE INTO blocked_dates (date,reason) VALUES (?,?)').run(date, reason || '');
  res.json({ success: true });
});

app.post('/api/admin/testimonial/:id/approve', adminAuth, (req, res) => {
  db.prepare('UPDATE testimonials SET approved=1 WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/testimonial/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM testimonials WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.patch('/api/admin/reservation/:id', adminAuth, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE reservations SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true });
});

// Email reminders cron — runs every hour
cron.schedule('0 * * * *', async () => {
  const tomorrow = new Date(Date.now() + 24*60*60*1000).toISOString().slice(0,10);
  const reminders = db.prepare("SELECT * FROM reservations WHERE date=? AND status='pending'").all(tomorrow);
  for (const r of reminders) {
    await sendEmail(r.email, 'Reminder: Your appointment tomorrow — Salt & Light', emailTemplate('See You Tomorrow!', `
      <p>Hi ${r.name}, just a reminder about your appointment tomorrow.</p>
      <table style="background:#f5ede0;padding:20px;border-radius:8px;width:100%">
        <tr><td><strong>Service:</strong></td><td>${r.station}</td></tr>
        <tr><td><strong>Date:</strong></td><td>${r.date}</td></tr>
        <tr><td><strong>Time:</strong></td><td>${r.time}</td></tr>
      </table>
      <p>Payment is collected in person. Cash prices shown; card adds 3.5%.</p>
    `));
  }
});

const PORT = process.env.PORT || 3900;
app.listen(PORT, '127.0.0.1', () => console.log(`🌿 Salt & Light server running on port ${PORT}`));

// Contact form — texts + emails all leads
app.post('/api/contact', async (req, res) => {
  const { name, phone, email, message, service } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });

  // Save as reservation lead
  db.prepare('INSERT INTO reservations (name,phone,email,station,notes,status) VALUES (?,?,?,?,?,?)').run(
    name, phone, email||'', service||'Inquiry', message||'', 'lead'
  );

  // Email alert to owner
  await sendEmail(
    process.env.OWNER_EMAIL || process.env.SMTP_USER,
    `🌿 New Lead: ${name}`,
    emailTemplate('New Contact Form Lead', `
      <p><strong>Name:</strong> ${name}</p>
      <p><strong>Phone:</strong> <a href="tel:${phone}">${phone}</a></p>
      <p><strong>Email:</strong> ${email||'not provided'}</p>
      <p><strong>Service interest:</strong> ${service||'General inquiry'}</p>
      <p><strong>Message:</strong> ${message||'none'}</p>
      <hr>
      <p style="font-size:12px">Reply quickly — leads convert best within 5 minutes.</p>
    `)
  );

  // Confirmation email to lead
  if (email) {
    await sendEmail(email, 'Thanks for reaching out — Salt & Light Wellness', emailTemplate(
      `Hi ${name}, we got your message!`,
      `<p>Thank you for contacting Salt & Light Wellness. We'll be in touch shortly to answer your questions and help you book your first session.</p>
      <p style="margin-top:16px">In the meantime, feel free to browse our <a href="https://saltandlight.com/pricing.html">pricing</a> or <a href="https://saltandlight.com/booking.html">book directly online</a>.</p>
      <p style="margin-top:16px">See you soon! 🌿</p>`
    ));
  }

  res.json({ success: true });
});
