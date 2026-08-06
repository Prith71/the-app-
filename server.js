require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { MongoClient } = require('mongodb');
const cloudinary = require('cloudinary').v2;
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const CHAT_PASSWORD = process.env.CHAT_PASSWORD || 'angycore##889145';
const CORE_PASSWORD = process.env.CORE_PASSWORD || 'angycore##889145';

// ---------------------------------------------------------------------------
// MongoDB Atlas — this is where all site data (chat, productions, status,
// trailer, founder/crew bios) lives. It's a free-forever hosted database,
// so nothing resets when your host (e.g. Render's free tier) redeploys or
// restarts — unlike a local disk, which isn't guaranteed to persist there.
// See README.md "Setting up MongoDB Atlas" for how to get a connection string.
// ---------------------------------------------------------------------------
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || 'angy_productions';

if (!MONGODB_URI) {
  console.error(
    'Missing MONGODB_URI in your .env file.\n' +
    'See README.md "Setting up MongoDB Atlas" for how to create a free ' +
    'cluster and get a connection string.'
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Cloudinary — this is where uploaded photos (founders/crew) live. Also
// free-forever on its free tier, and also outside your host, so photos
// survive redeploys too.
// See README.md "Setting up Cloudinary" for how to get these three values.
// ---------------------------------------------------------------------------
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME;
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_API_KEY || !CLOUDINARY_API_SECRET) {
  console.error(
    'Missing Cloudinary credentials in your .env file ' +
    '(CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET).\n' +
    'See README.md "Setting up Cloudinary" for how to get them.'
  );
  process.exit(1);
}

cloudinary.config({
  cloud_name: CLOUDINARY_CLOUD_NAME,
  api_key: CLOUDINARY_API_KEY,
  api_secret: CLOUDINARY_API_SECRET
});

// ---------------------------------------------------------------------------
// "People groups" — any section of the site that's a list of people with a
// photo + bio, editable only by Core. Founders and the SIX crew both use
// this same system. To add another one later, just add another entry here.
// ---------------------------------------------------------------------------
const PEOPLE_GROUPS = {
  founders: ['urvish', 'ayush', 'pranjal', 'nayna'],
  crew: ['urvish', 'aayush', 'abhishek', 'pranjal', 'sabarna', 'naina', 'asmit']
};
const GROUP_NAMES = Object.keys(PEOPLE_GROUPS);

function emptyPerson() {
  return { photo: '', photoPublicId: '', bio: '' };
}
function defaultGroupData(ids) {
  const o = {};
  ids.forEach((id) => { o[id] = emptyPerson(); });
  return o;
}

const DEFAULT_DB = {
  productions: ['SIX'],
  status: 'In Production',
  trailer: '',
  messages: [],
  messageSeq: 0,
  founders: defaultGroupData(PEOPLE_GROUPS.founders),
  crew: defaultGroupData(PEOPLE_GROUPS.crew)
};

// Everything lives in one document in one collection — simplest possible
// shape, and easy to reason about (same idea as the old db.json file, just
// hosted in Mongo instead of on disk).
const STATE_DOC_ID = 'main';

let db = null;           // in-memory mirror of the state document
let stateCollection = null;

function mergeWithDefaults(parsed) {
  const merged = { ...DEFAULT_DB, ...(parsed || {}) };

  // Backfill id/pinned on any messages saved before pin/delete existed,
  // and make sure messageSeq is always ahead of the highest id in use.
  let maxId = 0;
  merged.messages = (merged.messages || []).map((m, i) => {
    const id = typeof m.id === 'number' ? m.id : i + 1;
    maxId = Math.max(maxId, id);
    return { ...m, id, pinned: !!m.pinned };
  });
  merged.messageSeq = Math.max(merged.messageSeq || 0, maxId);

  // Merge each people-group per-id, so older saved states (from before a
  // group existed, or before a new person was added) still end up with
  // every current person's slot present.
  GROUP_NAMES.forEach((group) => {
    merged[group] = {};
    PEOPLE_GROUPS[group].forEach((id) => {
      const existing = parsed && parsed[group] && parsed[group][id];
      merged[group][id] = { ...emptyPerson(), ...(existing || {}) };
    });
  });

  return merged;
}

async function connectDb() {
  const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const mongoDb = client.db(MONGODB_DB_NAME);
  stateCollection = mongoDb.collection('state');

  const existing = await stateCollection.findOne({ _id: STATE_DOC_ID });
  db = mergeWithDefaults(existing);
  await stateCollection.replaceOne(
    { _id: STATE_DOC_ID },
    { _id: STATE_DOC_ID, ...db },
    { upsert: true }
  );

  console.log('Connected to MongoDB Atlas.');
}

function saveDb() {
  // Fire-and-forget — callers don't wait on this, matching how the old
  // synchronous fs.writeFileSync-based saveDb() was called everywhere.
  stateCollection
    .replaceOne({ _id: STATE_DOC_ID }, { _id: STATE_DOC_ID, ...db }, { upsert: true })
    .catch((err) => console.error('Could not save to MongoDB:', err.message));
}

// ---------------------------------------------------------------------------
// Brute-force lockout for password attempts (per socket connection)
// ---------------------------------------------------------------------------
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 30 * 1000; // 30 seconds

function checkLockout(socket, kind) {
  const key = kind + 'Lock';
  const state = socket.data[key];
  if (state && state.until > Date.now()) {
    return Math.ceil((state.until - Date.now()) / 1000);
  }
  return 0;
}

function registerFailure(socket, kind) {
  const key = kind + 'Fails';
  const lockKey = kind + 'Lock';
  socket.data[key] = (socket.data[key] || 0) + 1;
  if (socket.data[key] >= MAX_ATTEMPTS) {
    socket.data[lockKey] = { until: Date.now() + LOCKOUT_MS };
    socket.data[key] = 0;
  }
}

function registerSuccess(socket, kind) {
  socket.data[kind + 'Fails'] = 0;
  socket.data[kind + 'Lock'] = null;
}

// ---------------------------------------------------------------------------
// Express + Socket.IO setup
// ---------------------------------------------------------------------------
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  storage: multer.memoryStorage(), // straight to memory, then off to Cloudinary
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(new Error('Only image files are allowed.'));
    }
    cb(null, true);
  }
});

function uploadBufferToCloudinary(buffer, folder, publicId) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, public_id: publicId, overwrite: true, resource_type: 'image' },
      (err, result) => (err ? reject(err) : resolve(result))
    );
    stream.end(buffer);
  });
}

// Core-only: upload/replace a person's photo in a given group.
// e.g. POST /api/people/founders/urvish/photo
// Sent as multipart/form-data with fields: code, photo
app.post('/api/people/:group/:id/photo', (req, res, next) => {
  const { group, id } = req.params;
  if (!GROUP_NAMES.includes(group) || !PEOPLE_GROUPS[group].includes(id)) {
    return res.status(404).json({ error: 'Unknown person.' });
  }
  next();
}, (req, res) => {
  const { group, id } = req.params;
  upload.single('photo')(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (req.body.code !== CORE_PASSWORD) {
      return res.status(401).json({ error: 'Wrong core access code.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'No photo received.' });
    }

    try {
      const oldPublicId = db[group][id].photoPublicId;
      const publicId = `${group}-${id}-${Date.now()}`;
      const result = await uploadBufferToCloudinary(
        req.file.buffer,
        `angy-productions/${group}`,
        publicId
      );

      db[group][id].photo = result.secure_url;
      db[group][id].photoPublicId = result.public_id;
      saveDb();
      io.emit(`${group}:update`, db[group]);
      res.json({ success: true, data: db[group] });

      // Best-effort cleanup of the old image — not awaited, doesn't block
      // the response, and failures here aren't fatal (just an orphaned
      // file sitting in Cloudinary).
      if (oldPublicId) {
        cloudinary.uploader.destroy(oldPublicId).catch(() => {});
      }
    } catch (uploadErr) {
      console.error('Cloudinary upload failed:', uploadErr.message);
      res.status(500).json({
        error: 'Upload failed on the server. Check your Cloudinary credentials in .env.'
      });
    }
  });
});

const server = http.createServer(app);
const io = new Server(server);

io.on('connection', (socket) => {
  socket.data = {};

  // Send public, always-visible data immediately on connect.
  socket.emit('init', {
    productions: db.productions,
    status: db.status,
    trailer: db.trailer,
    founders: db.founders,
    crew: db.crew
  });

  // ---------------- CHAT AUTH ----------------
  socket.on('chat:auth', (code) => {
    const wait = checkLockout(socket, 'chat');
    if (wait > 0) {
      socket.emit('chat:auth:result', { success: false, locked: true, wait });
      return;
    }
    if (code === CHAT_PASSWORD) {
      registerSuccess(socket, 'chat');
      socket.data.chatAuthed = true;
      socket.data.chatSenderId = crypto.randomUUID();
      socket.emit('chat:auth:result', { success: true, senderId: socket.data.chatSenderId });
      socket.emit('chat:history', db.messages);
    } else {
      registerFailure(socket, 'chat');
      const remaining = Math.max(0, MAX_ATTEMPTS - (socket.data.chatFails || 0));
      socket.emit('chat:auth:result', { success: false, remaining });
    }
  });

  socket.on('chat:send', ({ name, text }) => {
    if (!socket.data.chatAuthed) return;
    const cleanName = String(name || 'Anonymous').slice(0, 40).trim() || 'Anonymous';
    const cleanText = String(text || '').slice(0, 2000).trim();
    if (!cleanText) return;
    db.messageSeq += 1;
    const message = {
      id: db.messageSeq,
      name: cleanName,
      text: cleanText,
      ts: Date.now(),
      senderId: socket.data.chatSenderId,
      pinned: false
    };
    db.messages.push(message);
    saveDb();
    io.emit('chat:new', message);
  });

  // Delete: allowed for Core (any message) or the original sender
  // (only within the same connection session — see README for why).
  socket.on('chat:delete', (id) => {
    if (!socket.data.chatAuthed) return;
    const idx = db.messages.findIndex((m) => m.id === id);
    if (idx === -1) return;
    const msg = db.messages[idx];
    const isOwner = msg.senderId && msg.senderId === socket.data.chatSenderId;
    if (!socket.data.coreAuthed && !isOwner) return;
    db.messages.splice(idx, 1);
    saveDb();
    io.emit('chat:deleted', { id });
  });

  // Pin/unpin: Core only.
  socket.on('chat:pin', ({ id, pinned }) => {
    if (!socket.data.coreAuthed) return;
    const msg = db.messages.find((m) => m.id === id);
    if (!msg) return;
    msg.pinned = !!pinned;
    saveDb();
    io.emit('chat:pinned', { id, pinned: msg.pinned });
  });

  // ---------------- CORE AUTH ----------------
  socket.on('core:auth', (code) => {
    const wait = checkLockout(socket, 'core');
    if (wait > 0) {
      socket.emit('core:auth:result', { success: false, locked: true, wait });
      return;
    }
    if (code === CORE_PASSWORD) {
      registerSuccess(socket, 'core');
      socket.data.coreAuthed = true;
      socket.emit('core:auth:result', { success: true });
    } else {
      registerFailure(socket, 'core');
      const remaining = Math.max(0, MAX_ATTEMPTS - (socket.data.coreFails || 0));
      socket.emit('core:auth:result', { success: false, remaining });
    }
  });

  // ---------------- CORE ACTIONS (require socket.data.coreAuthed) ----------------
  socket.on('core:add-production', (title) => {
    if (!socket.data.coreAuthed) return;
    const clean = String(title || '').slice(0, 80).trim();
    if (!clean) return;
    db.productions.push(clean);
    saveDb();
    io.emit('productions:update', db.productions);
  });

  socket.on('core:remove-production', (index) => {
    if (!socket.data.coreAuthed) return;
    if (typeof index !== 'number' || index < 0 || index >= db.productions.length) return;
    db.productions.splice(index, 1);
    saveDb();
    io.emit('productions:update', db.productions);
  });

  socket.on('core:set-status', (value) => {
    if (!socket.data.coreAuthed) return;
    const clean = String(value || '').slice(0, 100).trim();
    if (!clean) return;
    db.status = clean;
    saveDb();
    io.emit('status:update', db.status);
  });

  socket.on('core:set-trailer', (value) => {
    if (!socket.data.coreAuthed) return;
    const clean = String(value || '').slice(0, 500).trim();
    db.trailer = clean;
    saveDb();
    io.emit('trailer:update', db.trailer);
  });

  // Shared bio-setter for any people group (founders, crew, ...).
  socket.on('core:set-person-bio', ({ group, id, bio }) => {
    if (!socket.data.coreAuthed) return;
    if (!GROUP_NAMES.includes(group) || !PEOPLE_GROUPS[group].includes(id)) return;
    const clean = String(bio || '').slice(0, 600);
    db[group][id].bio = clean;
    saveDb();
    io.emit(`${group}:update`, db[group]);
  });
});

async function start() {
  await connectDb();
  server.listen(PORT, () => {
    console.log(`Angy Productions server running at http://localhost:${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start server:', err.message);
  process.exit(1);
});
