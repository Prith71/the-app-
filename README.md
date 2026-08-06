# Angy Productions — full backend

A real Node.js server for the Angy Productions site. Chat messages, the
productions list, status, trailer link, and founder/crew bios are all stored
in **MongoDB Atlas** (a free, hosted database). Uploaded photos are stored in
**Cloudinary** (a free image host). Both are outside your own server, so
nothing resets when your host restarts or redeploys — which matters because
most free hosting tiers (like Render's) don't guarantee local disk storage
survives a redeploy. Everything updates live across every open browser tab
using Socket.IO. Nothing depends on Claude — this runs completely on your
own machine or any host you deploy it to.

## 1. Requirements

- [Node.js](https://nodejs.org) version 18 or newer (includes npm).

Check you have it:
```bash
node -v
npm -v
```

## 2. Setup

Open this folder in VS Code, then in the built-in terminal (`` Ctrl+` ``):

```bash
npm install
```

### Set up MongoDB Atlas

This is where chat, productions, status, trailer, and bios live.

1. Go to [mongodb.com/cloud/atlas/register](https://www.mongodb.com/cloud/atlas/register) and sign up (free, no credit card needed for the free tier).
2. Create a new **free (M0) cluster** — pick any cloud provider/region, the defaults are fine.
3. When prompted to create a database user, set a username and password. **Write these down** — you'll need them in a moment. (Avoid `@`, `/`, or `:` in the password — they can break the connection string. Letters and numbers are safest.)
4. Under **Network Access**, click **Add IP Address** → **Allow Access from Anywhere** (`0.0.0.0/0`). This is needed because your host (e.g. Render) doesn't have a fixed IP.
5. Go to your cluster → **Connect** → **Drivers**. Copy the connection string — it looks like:
   ```
   mongodb+srv://<username>:<password>@your-cluster.mongodb.net/?retryWrites=true&w=majority
   ```
6. Replace `<username>` and `<password>` with what you set in step 3.

### Set up Cloudinary

This is where uploaded photos live.

1. Go to [cloudinary.com](https://cloudinary.com) and sign up (free tier, no credit card needed).
2. On your Cloudinary Dashboard, you'll see **Cloud Name**, **API Key**, and **API Secret** right at the top. Copy all three.

### Put it all together

Copy `.env.example` to a new file called `.env`:

```bash
cp .env.example .env
```

Open `.env` and fill in:
- `MONGODB_URI` — the connection string from Atlas (with your real username/password in it)
- `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET` — from your Cloudinary dashboard
- `CHAT_PASSWORD` and `CORE_PASSWORD` — whatever you want them to be

`.env` is in `.gitignore` so none of this ever gets committed if you push this to GitHub.

## 3. Run it

```bash
npm start
```

You'll see:
```
Connected to MongoDB Atlas.
Angy Productions server running at http://localhost:3000
```

If it instead prints an error and exits, read the message — it'll tell you
exactly which credential is missing or wrong (see **Troubleshooting** below).

Open `http://localhost:3000` in your browser. Open it in a second tab (or on
your phone, using your computer's local IP address instead of `localhost`)
and the chat, productions list, status, and trailer will all update live
between the two.

## 4. How data is stored

Everything (productions, status, trailer, chat messages, founder/crew bios)
lives in a single document inside a `state` collection in your MongoDB Atlas
cluster. You can view or edit it directly any time from the Atlas dashboard
(**Browse Collections**).

Uploaded photos are stored in Cloudinary, under folders
`angy-productions/founders/` and `angy-productions/crew/`. Uploading a new
photo for someone automatically deletes their old one from Cloudinary, so
old files don't pile up.

### Founders page & SIX → Core Team tab

Both pages work the same way — each person has a photo and a short bio,
editable **only by Core** (same access code as everywhere else):
1. Click **Core access** and enter the code.
2. A bio textarea and a photo file-picker appear on each person's card.
3. Uploading a photo asks you to re-confirm the core code (it's a separate
   plain HTTP request, not part of the live socket session, so it checks
   again to make sure only Core can upload files).
4. Both the photo and bio update live for everyone viewing the page.

Under the hood, both pages are powered by the same generic "people group"
system in `server.js` (`PEOPLE_GROUPS`). If you ever want to add another
page like this — say, a Cast page with photos — you'd add one entry to
`PEOPLE_GROUPS` in `server.js` and one matching entry to `PEOPLE_GROUPS` in
`public/app.js`, and the upload endpoint, storage, and live updates all
work automatically without writing new backend code.

### Chat: pinning and deleting messages

- **Delete:** anyone in the chat can delete their own message. Core can
  delete *any* message (moderation). Deleting removes it from the database
  for good — there's no undo.
- **Pin:** Core-only. Pinned messages show in a strip at the top of the
  chat, above the normal scrolling log, so announcements don't get buried.
- Hover over a message to see the 🗑 (and 📌 if you're Core) action
  buttons appear.
- One limitation worth knowing: "your own messages" are tracked per
  browser tab session, not a real login. If you refresh the page or
  reopen the chat, you can still see and use pin/delete if you're Core,
  but you lose the ability to delete messages *you* sent before that
  refresh (Core can still delete them for you). This is a deliberate
  trade-off to avoid needing full user accounts for a small crew chat.

## 5. Security notes

- Passwords are checked **on the server**, not in the browser, so they can't
  be read from "view source" or dev tools.
- Both the chat gate and Core access lock out an individual browser
  connection for 30 seconds after 5 wrong password attempts in a row.
- This is a small hobby-project-grade backend (no HTTPS, no rate limiting
  beyond the lockout above, no user accounts). Fine for a private
  crew site. If you ever deploy it somewhere public-facing, put it behind
  HTTPS (most hosts like Render do this for you automatically).
- Never commit `.env` or paste your Mongo/Cloudinary credentials anywhere
  public — anyone with your `MONGODB_URI` can read/write your whole
  database, and anyone with your Cloudinary keys can upload/delete images
  on your account.

## 6. Sharing it with others (deploying it for real)

Running `npm start` on your own laptop only works while your laptop is on
and that terminal is open — nobody else can reach it. To give people a real
link they can open anytime, host it on a server that runs 24/7. The easiest
free option for a small project like this is **[Render](https://render.com)**.

Because your data now lives in MongoDB Atlas and Cloudinary instead of a
local disk, **you don't need Render's persistent disk feature at all** —
that's the whole point of this setup. The free web service tier is enough.

### Step-by-step (Render)

1. **Put the code on GitHub** (skip if you've already done this).
   - Create a free GitHub account if you don't have one.
   - Create a new repository, then upload this whole `angy-backend` folder's
     *contents* to it (in VS Code: Source Control tab → Publish to GitHub is
     the easiest way, or use `git init`, `git add .`, `git commit`, `git push`
     from the terminal).
   - Do **not** upload your `.env` file — `.gitignore` already excludes it.

2. **Create the service on Render.**
   - Sign up at render.com (free, no credit card needed).
   - Click **New +** → **Web Service**.
   - Connect your GitHub account and pick the repo you just created.
   - Set:
     - **Build Command:** `npm install`
     - **Start Command:** `npm start`
     - **Instance Type:** Free

3. **Set your environment variables.**
   - In the service's **Environment** tab, add all of these (same values as your `.env`):
     - `MONGODB_URI`
     - `CLOUDINARY_CLOUD_NAME`
     - `CLOUDINARY_API_KEY`
     - `CLOUDINARY_API_SECRET`
     - `CHAT_PASSWORD`
     - `CORE_PASSWORD`

4. **Deploy.**
   - Render builds and starts it automatically. After a minute or two you'll
     get a public URL like `https://angy-productions.onrender.com`.
   - Share that link with anyone — no code editor, no VS Code, no setup
     needed on their end. It just opens in their browser.

**Note on the free tier:** Render's free web services "sleep" after 15
minutes of no traffic, and take ~30–60 seconds to wake back up on the next
visit. That's fine for a crew hangout site — your data is safe in MongoDB
either way, sleeping or not. If that wake-up delay bothers you, Render's
cheapest paid tier ($7/month) keeps it always-on instantly (still no disk
needed, since MongoDB/Cloudinary aren't on Render at all).

### Other options

This is a completely standard Express + Socket.IO app, so the same steps
work on **Railway**, **Fly.io**, or any VPS — set the same six environment
variables there instead of using `.env`. Since state lives in MongoDB and
Cloudinary rather than local disk, you're not locked into any one host —
you can move it later without losing any data.

## 7. Troubleshooting

**"Missing MONGODB_URI in your .env file"** — you haven't created `.env`
yet, or it's missing that line. Copy `.env.example` to `.env` and fill it in.

**Server hangs for ~8 seconds then prints a connection error** — your
`MONGODB_URI` is wrong, or Atlas's Network Access list doesn't include
`0.0.0.0/0` (see setup step 4 above), or your password in the URI has a
special character breaking it. Double-check each part of the connection
string.

**"Upload failed on the server. Check your Cloudinary credentials."** — one
of `CLOUDINARY_CLOUD_NAME` / `CLOUDINARY_API_KEY` / `CLOUDINARY_API_SECRET`
is wrong. Recheck them against your Cloudinary dashboard.

## 8. Project structure

```
angy-backend/
  server.js          -> the whole backend (Express + Socket.IO + MongoDB + Cloudinary)
  package.json
  .env.example        -> copy to .env and fill in your real credentials
  public/
    index.html          -> page structure
    style.css            -> all styling
    app.js                -> frontend logic, talks to server.js over sockets
    assets/logo-icon.png   -> your logo
```
