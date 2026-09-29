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

const BTS_SLOT_COUNT = 20;
function emptyBtsSlot() {
  return { photo: '', photoPublicId: '', caption: '' };
}
function defaultBtsPhotos() {
  return Array.from({ length: BTS_SLOT_COUNT }, emptyBtsSlot);
}

function emptyWallPerson() {
  return { photo: '', photoPublicId: '', bio: '' };
}

// Lines wrapped in *asterisks* render as a big bold title in the UI;
// lines wrapped in "quotes" render as an italic pull-quote. Everything
// else is a plain paragraph. See renderWallDescription() in app.js.
const WALL_DEFAULT_DESCRIPTION = [
  "A psychological meta-thriller about Siddhartha, a young man who's reality takes an unsettling turn after a strange discovery.",
  '',
  '*WALL*',
  '',
  'As paranoia sets in, the line between reality and perception begins to blur, leaving Siddhartha questioning everything around him and eventually, himself.',
  '',
  '"somewhere between what you know and what you believe lies the truth."',
  '',
  'A short film about identity, paranoia, and a reality that may or may not be what it seems.'
].join('\n');

const DEFAULT_DB = {
  productions: ['SIX', 'Wall'],
  status: 'In Production',
  trailer: '',
  messages: [],
  messageSeq: 0,
  founders: defaultGroupData(PEOPLE_GROUPS.founders),
  crew: defaultGroupData(PEOPLE_GROUPS.crew),
  bts: { link: '', photos: defaultBtsPhotos() },
  doubts: [],
  doubtSeq: 0,
  presence: {}, // { [chatName]: lastSeenTimestampMs }
  wall: {
    description: WALL_DEFAULT_DESCRIPTION,
    crew: [],   // [{id, name, photo, photoPublicId, bio}] — Core adds/removes freely
    cast: [],   // same shape as crew
    crewSeq: 0,
    castSeq: 0,
    status: '',
    trailer: '',
    bts: { link: '', photos: defaultBtsPhotos() }
  }
};

// Everything lives in one document in one collection — simplest possible
// shape, and easy to reason about (same idea as the old db.json file, just
// hosted in Mongo instead of on disk).
const STATE_DOC_ID = 'main';

let db = null;           // in-memory mirror of the state document
let stateCollection = null;

function mergeWithDefaults(parsed) {
  const merged = { ...DEFAULT_DB, ...(parsed || {}) };

  // Backfill id/pinned/fromDoubt on any messages saved before those
  // existed, and make sure messageSeq is always ahead of the highest id
  // in use.
  let maxId = 0;
  merged.messages = (merged.messages || []).map((m, i) => {
    const id = typeof m.id === 'number' ? m.id : i + 1;
    maxId = Math.max(maxId, id);
    return { ...m, id, pinned: !!m.pinned, fromDoubt: !!m.fromDoubt };
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

  // BTS: always exactly BTS_SLOT_COUNT slots, each with the full shape.
  const existingBts = (parsed && parsed.bts) || {};
  const existingPhotos = Array.isArray(existingBts.photos) ? existingBts.photos : [];
  merged.bts = {
    link: typeof existingBts.link === 'string' ? existingBts.link : '',
    photos: Array.from({ length: BTS_SLOT_COUNT }, (_, i) => ({
      ...emptyBtsSlot(),
      ...(existingPhotos[i] || {})
    }))
  };

  // Doubts: backfill ids, keep doubtSeq ahead of the highest id in use.
  // Doubts saved before replies existed get a fresh token here — their
  // original asker never received it (the feature didn't exist yet), so
  // those particular doubts just won't surface a reply for anyone, which
  // is the correct/safe behavior rather than guessing an owner.
  let maxDoubtId = 0;
  merged.doubts = (merged.doubts || []).map((d, i) => {
    const id = typeof d.id === 'number' ? d.id : i + 1;
    maxDoubtId = Math.max(maxDoubtId, id);
    return {
      ...d,
      id,
      token: typeof d.token === 'string' ? d.token : crypto.randomUUID(),
      reply: typeof d.reply === 'string' ? d.reply : '',
      repliedAt: typeof d.repliedAt === 'number' ? d.repliedAt : null
    };
  });
  merged.doubtSeq = Math.max(merged.doubtSeq || 0, maxDoubtId);

  // Presence: just a flat name -> lastSeen map, nothing to migrate beyond
  // making sure it exists.
  merged.presence = (parsed && typeof parsed.presence === 'object' && parsed.presence) || {};

  // Wall: dynamic crew/cast lists (Core can add/remove people freely,
  // unlike the fixed Founders/Crew rosters above), plus description,
  // status, trailer, and its own BTS gallery.
  const wallExistedBefore = !!(parsed && parsed.wall);
  const existingWall = (parsed && parsed.wall) || {};
  const existingWallBts = existingWall.bts || {};
  const existingWallBtsPhotos = Array.isArray(existingWallBts.photos) ? existingWallBts.photos : [];

  function migrateWallPersonList(list) {
    let maxPersonId = 0;
    const items = (Array.isArray(list) ? list : []).map((p, i) => {
      const id = typeof p.id === 'number' ? p.id : i + 1;
      maxPersonId = Math.max(maxPersonId, id);
      return { ...emptyWallPerson(), ...p, id };
    });
    return { items, maxPersonId };
  }
  const migratedCrew = migrateWallPersonList(existingWall.crew);
  const migratedCast = migrateWallPersonList(existingWall.cast);

  merged.wall = {
    description: typeof existingWall.description === 'string'
      ? existingWall.description
      : WALL_DEFAULT_DESCRIPTION,
    crew: migratedCrew.items,
    cast: migratedCast.items,
    crewSeq: Math.max(existingWall.crewSeq || 0, migratedCrew.maxPersonId),
    castSeq: Math.max(existingWall.castSeq || 0, migratedCast.maxPersonId),
    status: typeof existingWall.status === 'string' ? existingWall.status : '',
    trailer: typeof existingWall.trailer === 'string' ? existingWall.trailer : '',
    bts: {
      link: typeof existingWallBts.link === 'string' ? existingWallBts.link : '',
      photos: Array.from({ length: BTS_SLOT_COUNT }, (_, i) => ({
        ...emptyBtsSlot(),
        ...(existingWallBtsPhotos[i] || {})
      }))
    }
  };

  // One-time seed: if this Mongo document never had Wall data before (an
  // existing deployment from before this feature shipped), add "Wall" to
  // the productions list too. Runs exactly once — after this, Core is
  // free to remove it and it won't be re-added on the next restart.
  if (!wallExistedBefore) {
    const hasWall = merged.productions.some((p) => String(p).trim().toLowerCase() === 'wall');
    if (!hasWall) merged.productions.push('Wall');
  }

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

// Core-only: upload/replace a BTS gallery photo in a given slot (1-20).
// Sent as multipart/form-data with fields: code, photo
app.post('/api/bts/:slot/photo', (req, res, next) => {
  const slotNum = parseInt(req.params.slot, 10);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > BTS_SLOT_COUNT) {
    return res.status(404).json({ error: 'Unknown BTS slot.' });
  }
  next();
}, (req, res) => {
  const slotIndex = parseInt(req.params.slot, 10) - 1;
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
      const oldPublicId = db.bts.photos[slotIndex].photoPublicId;
      const publicId = `bts-${slotIndex + 1}-${Date.now()}`;
      const result = await uploadBufferToCloudinary(
        req.file.buffer,
        'angy-productions/bts',
        publicId
      );

      db.bts.photos[slotIndex].photo = result.secure_url;
      db.bts.photos[slotIndex].photoPublicId = result.public_id;
      saveDb();
      io.emit('bts:update', db.bts);
      res.json({ success: true, data: db.bts });

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

// Core-only: upload/replace a Wall crew or cast member's photo.
// e.g. POST /api/wall/crew/3/photo or /api/wall/cast/7/photo
// Core-only: upload/replace a Wall BTS gallery photo in a given slot (1-20).
// Registered before the generic /api/wall/:list/:id/photo route below —
// Express matches routes in definition order, not by specificity, so this
// more specific path must come first or "bts" would get treated as a
// :list value and incorrectly rejected as "Unknown list."
app.post('/api/wall/bts/:slot/photo', (req, res, next) => {
  const slotNum = parseInt(req.params.slot, 10);
  if (!Number.isInteger(slotNum) || slotNum < 1 || slotNum > BTS_SLOT_COUNT) {
    return res.status(404).json({ error: 'Unknown BTS slot.' });
  }
  next();
}, (req, res) => {
  const slotIndex = parseInt(req.params.slot, 10) - 1;
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
      const oldPublicId = db.wall.bts.photos[slotIndex].photoPublicId;
      const publicId = `wall-bts-${slotIndex + 1}-${Date.now()}`;
      const result = await uploadBufferToCloudinary(
        req.file.buffer,
        'angy-productions/wall-bts',
        publicId
      );

      db.wall.bts.photos[slotIndex].photo = result.secure_url;
      db.wall.bts.photos[slotIndex].photoPublicId = result.public_id;
      saveDb();
      io.emit('wall:update', db.wall);
      res.json({ success: true, data: db.wall });

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

// Core-only: upload/replace a Wall crew or cast member's photo.
// e.g. POST /api/wall/crew/3/photo or /api/wall/cast/7/photo
app.post('/api/wall/:list/:id/photo', (req, res, next) => {
  const { list } = req.params;
  if (!['crew', 'cast'].includes(list)) {
    return res.status(404).json({ error: 'Unknown list.' });
  }
  next();
}, (req, res) => {
  const { list, id } = req.params;
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
    const person = db.wall[list].find((p) => p.id === Number(id));
    if (!person) {
      return res.status(404).json({ error: 'Unknown person.' });
    }

    try {
      const oldPublicId = person.photoPublicId;
      const publicId = `wall-${list}-${id}-${Date.now()}`;
      const result = await uploadBufferToCloudinary(
        req.file.buffer,
        `angy-productions/wall-${list}`,
        publicId
      );

      person.photo = result.secure_url;
      person.photoPublicId = result.public_id;
      saveDb();
      io.emit('wall:update', db.wall);
      res.json({ success: true, data: db.wall });

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

// ---------------------------------------------------------------------------
// Presence: who's online right now (in-memory, resets on restart — that's
// expected, "online now" is inherently a live/transient thing) plus
// last-seen timestamps per name (persisted in Mongo via db.presence, so
// "last online" survives restarts for people who aren't currently here).
// ---------------------------------------------------------------------------
const onlineNames = new Map(); // socket.id -> chat display name

function broadcastPresence() {
  const online = [...new Set(onlineNames.values())];
  io.emit('presence:update', { online, lastSeen: db.presence });
}

function markSeen(name) {
  if (!name) return;
  db.presence[name] = Date.now();
  saveDb();
}

io.on('connection', (socket) => {
  socket.data = {};

  // Send public, always-visible data immediately on connect.
  socket.emit('init', {
    productions: db.productions,
    status: db.status,
    trailer: db.trailer,
    founders: db.founders,
    crew: db.crew,
    bts: db.bts,
    wall: db.wall,
    presence: { online: [...new Set(onlineNames.values())], lastSeen: db.presence }
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
      socket.join('chat'); // so chat:new/deleted/pinned reach only chat-authed sockets
      socket.emit('chat:auth:result', { success: true, senderId: socket.data.chatSenderId });
      socket.emit('chat:history', db.messages);
    } else {
      registerFailure(socket, 'chat');
      const remaining = Math.max(0, MAX_ATTEMPTS - (socket.data.chatFails || 0));
      socket.emit('chat:auth:result', { success: false, remaining });
    }
  });

  // Registers/updates this socket's display name — called as soon as
  // someone picks a name (not just when they send their first message),
  // so presence shows them online right away.
  socket.on('chat:set-name', (name) => {
    if (!socket.data.chatAuthed) return;
    const clean = String(name || '').slice(0, 40).trim();
    if (!clean) return;
    socket.data.chatName = clean;
    onlineNames.set(socket.id, clean);
    markSeen(clean);
    broadcastPresence();
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
      pinned: false,
      fromDoubt: false
    };
    db.messages.push(message);
    markSeen(cleanName);
    saveDb();
    io.to('chat').emit('chat:new', message);
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
    io.to('chat').emit('chat:deleted', { id });
  });

  // Pin/unpin: Core only.
  socket.on('chat:pin', ({ id, pinned }) => {
    if (!socket.data.coreAuthed) return;
    const msg = db.messages.find((m) => m.id === id);
    if (!msg) return;
    msg.pinned = !!pinned;
    saveDb();
    io.to('chat').emit('chat:pinned', { id, pinned: msg.pinned });
  });

  // Core-only: post a doubt's question into the crew chat, so everyone can
  // discuss it together. Doesn't require the Core member to have also
  // unlocked chat separately — being Core is enough trust for this.
  socket.on('core:tag-doubt-to-chat', (doubtId) => {
    if (!socket.data.coreAuthed) return;
    const doubt = db.doubts.find((d) => d.id === doubtId);
    if (!doubt) return;
    db.messageSeq += 1;
    const message = {
      id: db.messageSeq,
      name: 'Core',
      text: doubt.text,
      ts: Date.now(),
      senderId: null,
      pinned: false,
      fromDoubt: true
    };
    db.messages.push(message);
    saveDb();
    io.to('chat').emit('chat:new', message);
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
      socket.join('core'); // so doubts:update broadcasts reach only Core sockets
      socket.emit('core:auth:result', { success: true });
      socket.emit('doubts:update', db.doubts); // private to this socket — not everyone
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
    const clean = String(bio || '').slice(0, 2000);
    db[group][id].bio = clean;
    saveDb();
    io.emit(`${group}:update`, db[group]);
  });

  // ---------------- WALL (second production, dynamic crew/cast) ----------------
  socket.on('core:set-wall-description', (text) => {
    if (!socket.data.coreAuthed) return;
    db.wall.description = String(text || '').slice(0, 3000);
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:set-wall-status', (value) => {
    if (!socket.data.coreAuthed) return;
    const clean = String(value || '').slice(0, 100).trim();
    if (!clean) return;
    db.wall.status = clean;
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:set-wall-trailer', (value) => {
    if (!socket.data.coreAuthed) return;
    db.wall.trailer = String(value || '').slice(0, 500).trim();
    saveDb();
    io.emit('wall:update', db.wall);
  });

  // Unlike the fixed Founders/Crew rosters, Wall's crew and cast are
  // fully dynamic — Core can add or remove people freely.
  socket.on('core:wall-add-person', ({ list, name }) => {
    if (!socket.data.coreAuthed) return;
    if (!['crew', 'cast'].includes(list)) return;
    const clean = String(name || '').slice(0, 60).trim();
    if (!clean) return;
    const seqKey = list + 'Seq';
    db.wall[seqKey] += 1;
    db.wall[list].push({ id: db.wall[seqKey], name: clean, photo: '', photoPublicId: '', bio: '' });
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:wall-remove-person', ({ list, id }) => {
    if (!socket.data.coreAuthed) return;
    if (!['crew', 'cast'].includes(list)) return;
    const idx = db.wall[list].findIndex((p) => p.id === id);
    if (idx === -1) return;
    const removed = db.wall[list][idx];
    db.wall[list].splice(idx, 1);
    saveDb();
    io.emit('wall:update', db.wall);
    if (removed.photoPublicId) {
      cloudinary.uploader.destroy(removed.photoPublicId).catch(() => {});
    }
  });

  socket.on('core:wall-set-person-bio', ({ list, id, bio }) => {
    if (!socket.data.coreAuthed) return;
    if (!['crew', 'cast'].includes(list)) return;
    const person = db.wall[list].find((p) => p.id === id);
    if (!person) return;
    person.bio = String(bio || '').slice(0, 2000);
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:set-wall-bts-link', (value) => {
    if (!socket.data.coreAuthed) return;
    db.wall.bts.link = String(value || '').slice(0, 500).trim();
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:set-wall-bts-caption', ({ slot, caption }) => {
    if (!socket.data.coreAuthed) return;
    const i = Number(slot) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= BTS_SLOT_COUNT) return;
    db.wall.bts.photos[i].caption = String(caption || '').slice(0, 160);
    saveDb();
    io.emit('wall:update', db.wall);
  });

  socket.on('core:delete-wall-bts-photo', (slot) => {
    if (!socket.data.coreAuthed) return;
    const i = Number(slot) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= BTS_SLOT_COUNT) return;
    const oldPublicId = db.wall.bts.photos[i].photoPublicId;
    db.wall.bts.photos[i] = emptyBtsSlot();
    saveDb();
    io.emit('wall:update', db.wall);
    if (oldPublicId) {
      cloudinary.uploader.destroy(oldPublicId).catch(() => {});
    }
  });

  // ---------------- BTS (Behind the Scenes) ----------------
  socket.on('core:set-bts-link', (value) => {
    if (!socket.data.coreAuthed) return;
    const clean = String(value || '').slice(0, 500).trim();
    db.bts.link = clean;
    saveDb();
    io.emit('bts:update', db.bts);
  });

  socket.on('core:set-bts-caption', ({ slot, caption }) => {
    if (!socket.data.coreAuthed) return;
    const i = Number(slot) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= BTS_SLOT_COUNT) return;
    // Roughly 20 words — a generous character cap rather than a strict
    // word-splitter, since counting words server-side is easy to game
    // anyway and this is just meant to keep captions short.
    const clean = String(caption || '').slice(0, 160);
    db.bts.photos[i].caption = clean;
    saveDb();
    io.emit('bts:update', db.bts);
  });

  socket.on('core:delete-bts-photo', (slot) => {
    if (!socket.data.coreAuthed) return;
    const i = Number(slot) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= BTS_SLOT_COUNT) return;
    const oldPublicId = db.bts.photos[i].photoPublicId;
    db.bts.photos[i] = emptyBtsSlot();
    saveDb();
    io.emit('bts:update', db.bts);
    if (oldPublicId) {
      cloudinary.uploader.destroy(oldPublicId).catch(() => {});
    }
  });

  // ---------------- DOUBTS (anonymous questions to Core) ----------------
  // Submitting requires no auth at all — that's the point, it's anonymous
  // and open to any visitor. Viewing the full list and deleting are
  // Core-only, and that list is only ever sent to sockets in the 'core'
  // room (joined on successful core:auth above) so regular visitors never
  // receive it.
  //
  // Replies are private to the original asker. Since doubts have no login
  // behind them, ownership is proven with a random token: the submitter's
  // browser gets the token once, right after submitting (never broadcast
  // to anyone else, not even Core's live feed), and saves it locally. To
  // check for a reply later, the browser sends back {id, token} pairs —
  // only exact id+token matches are returned, so nobody else can read
  // someone else's reply even if they somehow knew the doubt's id.
  socket.on('doubt:submit', (text) => {
    const clean = String(text || '').slice(0, 500).trim();
    if (!clean) return;
    db.doubtSeq += 1;
    const token = crypto.randomUUID();
    const doubt = {
      id: db.doubtSeq,
      text: clean,
      ts: Date.now(),
      token,
      reply: '',
      repliedAt: null
    };
    db.doubts.push(doubt);
    saveDb();
    io.to('core').emit('doubts:update', db.doubts);
    socket.emit('doubt:submitted', { id: doubt.id, token }); // private to the submitter only
  });

  socket.on('doubt:reply', ({ id, reply }) => {
    if (!socket.data.coreAuthed) return;
    const doubt = db.doubts.find((d) => d.id === id);
    if (!doubt) return;
    const clean = String(reply || '').slice(0, 500).trim();
    doubt.reply = clean;
    doubt.repliedAt = clean ? Date.now() : null;
    saveDb();
    io.to('core').emit('doubts:update', db.doubts);
  });

  // A browser checks its locally-saved {id, token} pairs against the
  // server to see if any of its own doubts have a reply yet. Only exact
  // matches come back — this is the only way reply content ever reaches
  // a non-Core socket.
  socket.on('doubt:check-mine', (mine) => {
    if (!Array.isArray(mine)) return;
    const results = mine
      .filter((m) => m && typeof m.id === 'number' && typeof m.token === 'string')
      .map(({ id, token }) => db.doubts.find((d) => d.id === id && d.token === token))
      .filter(Boolean)
      .map((d) => ({ id: d.id, text: d.text, ts: d.ts, reply: d.reply, repliedAt: d.repliedAt }));
    socket.emit('doubt:mine-update', results);
  });

  socket.on('doubt:delete', (id) => {
    if (!socket.data.coreAuthed) return;
    const idx = db.doubts.findIndex((d) => d.id === id);
    if (idx === -1) return;
    db.doubts.splice(idx, 1);
    saveDb();
    io.to('core').emit('doubts:update', db.doubts);
  });

  socket.on('disconnect', () => {
    if (socket.data.chatName) {
      markSeen(socket.data.chatName); // last-seen = the moment they left
      onlineNames.delete(socket.id);
      broadcastPresence();
    }
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
