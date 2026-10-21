# Getting started: a step-by-step guide for non-programmers

This guide takes you from nothing to a working training planner, with no programming knowledge needed. When you finish you will have:

- **The tracker**: a private website only you can sign in to, showing today's training, your plan, your progress and your settings.
- **The Telegram bot**: messages at 07:00, 21:30 and Sunday evening, with buttons to mark sessions Done, Skip or Tomorrow.
- **Watch sync**: runs, hikes and climbs recorded on your watch are credited automatically through intervals.icu.

**Time:** about 45 minutes. **Cost:** free. Everything runs on free plans.

You will type a few commands into a *terminal*, a window where you type instructions instead of clicking. Copy each command from this guide exactly, paste it, and press **Enter**. Nothing here can damage your computer.

---

## Part 1: Create the accounts (15 minutes)

You need three free accounts. Make them now, in your web browser.

### 1.1 Cloudflare: where the app runs

1. Go to **https://dash.cloudflare.com/sign-up** and sign up with your email.
2. Confirm your email when Cloudflare sends the link.

You don't need to add a website or a domain. Skip anything that asks you to.

### 1.2 Telegram: the chat app for reminders

1. Install **Telegram** on your phone (App Store or Google Play) and create an account.
2. Optional but handy: install **Telegram Desktop** from https://desktop.telegram.org and log in. It is easier to copy and paste from during setup.

### 1.3 intervals.icu: connects your watch

The planner reads your watch Activities from intervals.icu, a free training site.

1. Go to **https://intervals.icu** and sign up.
2. Open **Settings** (the gear icon), then find **Connections**.
3. Connect the service your watch uses: **Garmin Connect**, **Coros**, **Suunto**, **Polar**, **Wahoo** or similar. Log in and allow access when asked.
   - ⚠️ **Don't rely on Strava** for this. Activities imported from Strava are not passed on to other apps, so the planner wouldn't see them. Connect the watch's own service directly.
4. Back in intervals.icu, check that some of your recent Activities appear in the calendar. The first import can take a few minutes.

You'll fetch the intervals.icu *API key* later, when the setup wizard asks for it.

---

## Part 2: Install two programs (10 minutes)

### 2.1 Node.js

Node.js runs the setup tools.

1. Go to **https://nodejs.org**.
2. Download the **LTS** version. It must be version **22 or newer**.
3. Run the installer and accept all the defaults.

### 2.2 Git

Git downloads the app's code. On Windows it also gives you **Git Bash**, the terminal this guide uses.

- **Windows:** download from **https://git-scm.com/download/win**, run the installer and accept all the defaults.
- **Mac:** open the **Terminal** app (press ⌘ + Space and type *Terminal*), type `git --version` and press Enter. If git isn't installed, the Mac offers to install it ("Command Line Developer Tools"). Click **Install**.

### 2.3 Open your terminal

- **Windows:** open the Start menu, type **Git Bash** and open it. Use Git Bash for every command in this guide, not PowerShell or Command Prompt.
- **Mac:** open **Terminal**.

Check that everything installed. Paste these lines one at a time and press Enter after each:

```bash
node --version
git --version
```

Each should print a version number. Node's must start with `v22` or higher. If you see "command not found", close the terminal, open it again and retry. If it still fails, re-run that installer.

> **Pasting in Git Bash:** right-click → Paste, or press **Shift + Insert**. Ctrl + V may not work.

---

## Part 3: Download the app (2 minutes)

In the terminal, paste:

```bash
cd ~
git clone https://github.com/Nishuy52/training-planner.git
cd training-planner/app
npm install
```

- `git clone` downloads the code into a folder called `training-planner` in your home folder.
- `npm install` downloads the building blocks the app needs. It prints a lot of text and takes a minute or two. Warnings are normal. Wait until the prompt (`$`) comes back.

---

## Part 4: Run the setup wizard (15 minutes)

The wizard does the technical work and tells you each time it needs a click in your browser or something pasted in. Start it:

```bash
cd ~/training-planner
bash app/scripts/deploy-wizard.sh
```

**Tips before you start**

- Keep the terminal and your browser side by side.
- When the wizard asks you to paste something, paste it and press **Enter**. When it says *(hidden)*, nothing shows as you paste. That's normal; just press Enter.
- **Don't use the arrow keys** at the wizard's questions; they get typed in as strange characters. To fix a typo, use Backspace.
- If something goes wrong, press **Ctrl + C** to stop, then run the wizard again. Running it again is safe. It remembers your addresses, bot username and Cloudflare values (press Enter to keep each one). For security it doesn't store the two secret codes, so you paste the Telegram token and the intervals.icu key again. BotFather shows the token any time under `/mybots` → your bot → **API Token**.

The wizard has 9 stages:

### Stage 1: Sign in to Cloudflare
Wrangler (Cloudflare's tool) may first ask whether it can send usage statistics. Answer either way. Then your browser opens a Cloudflare page. Click **Allow**, then go back to the terminal. It shows the email you're signed in with. Press **Enter** if that's right.

### Stage 2: Create the database
This happens automatically. When it asks *"Ok to proceed?"*, type **y** and press Enter.

### Stage 3: First deploy
The wizard puts the app online as two parts:
- **training**: the tracker website
- **training-bot**: the part Telegram talks to

The first time, Cloudflare may ask you to **choose a workers.dev subdomain**. This is a name of your choice that becomes part of your app's address, e.g. `alex-training`. Pick anything that's free.

Each part prints an address ending in `.workers.dev`. The wizard then asks for them:
1. Find the line with `https://training.<your-name>.workers.dev`, select it with the mouse, copy it, and paste it at the first question.
2. Do the same for `https://training-bot.<your-name>.workers.dev` at the second question.

### Stage 4: Create your Telegram bot
Telegram opens a chat with **@BotFather**, Telegram's official bot for making bots.
1. Send **/newbot**.
2. BotFather asks for a **name**. This is the display name, e.g. *My Training*.
3. BotFather asks for a **username**. It must end in `bot`, e.g. `alex_training_bot`. Try another if it's taken.
4. BotFather replies with a **token**, a long code like `123456789:AA…`. Treat it like a password.
5. Back in the terminal, type the bot's username (without the @), then paste the token (hidden). The wizard checks the token with Telegram.

### Stage 5: Your chat ID
This tells the app which chat to message. It answers only you.
1. The wizard opens your new bot in Telegram. Press **Start**, or send it any message, e.g. *hi*.
2. Go back to the terminal and press **Enter**. The wizard finds your chat ID by itself.

### Stage 6: Connect Telegram to the app
This happens automatically. The wizard moves straight on to Stage 7 when it works, and stops with an error if it doesn't.

### Stage 7: Lock the tracker behind your email
This makes the tracker private: only someone who can read your email can sign in. The wizard opens the Cloudflare dashboard.
1. Go to **Settings → Domains & Routes**. On the **workers.dev** row, click **Enable Cloudflare Access**. If there is a **Preview URLs** row, do the same there.
2. If Cloudflare asks you to create a **Zero Trust team**, type any team name and choose the **Free** plan. Cloudflare may ask for a payment card to activate the free plan. The Free plan costs nothing.
3. A box shows two values, **POLICY_AUD** and **TEAM_DOMAIN**. **Leave this box open.**
4. Click **Manage Cloudflare Access** and check that the policy allows **your email address**. Add it if it isn't there.
5. If you see a cookie setting called **SameSite**, set it to **Lax**.
6. Back in the terminal, paste **POLICY_AUD**, then **TEAM_DOMAIN**.

⚠️ Only do this for **training**. **Don't** enable Access on **training-bot**; Telegram can't sign in, so the bot would stop working. A secret code protects the bot instead.

### Stage 8: Connect your watch (intervals.icu)
1. In intervals.icu, go to **Settings**, scroll to **Developer Settings**, and click to generate an **API key**.
2. Copy it and paste it into the terminal (hidden). The wizard checks it with intervals.icu.

No watch, or you want to do this later? Press **Enter** without pasting anything, then **y**. The planner still works; watch Activities just aren't credited until you add the key (see [Troubleshooting](#troubleshooting)). You can log hikes by hand with `/log` meanwhile.

### Stage 9: Test everything
1. The wizard opens your tracker. Enter your email, then the one-time code Cloudflare emails you.
2. The **Today** page should load without a red error banner.
3. Go to **Progress → Recent Activities** and click **Sync now**. Your runs, hikes and climbs from the **last 14 days** should appear. Older Activities and other sports (walks, cycling…) are not shown. If you have none from the last two weeks, the list stays empty. That's fine; record a run and try again.
4. In Telegram, send **/today** to your bot. It should reply with today's plan and buttons.

The wizard ends with **"Setup complete"** and lists anything still left to do.

> **Bookmark your tracker address** (`https://training.<your-name>.workers.dev`). On your phone, open it in the browser and choose **Add to Home Screen** so it opens like an app.

---

## Part 5: Make the plan yours (10 minutes)

Open the tracker and tap **More**. Work through these in order.

1. **Settings**
   - **Default timezone:** where you usually live, written like `Europe/London` or `America/New_York`. Reminders and `/today` follow it. **Set this first.** A new install starts on `Europe/Berlin`, so until you change it, reminders arrive at Berlin time.
   - **Home location:** your town, e.g. `Leeds, UK`. It is only used by the optional automatic route suggestions ([weekly routes](routines/weekly-routes.md)), so you can leave it.
   - **Gym Profiles:** edit *Home Gym* to match your gym, e.g. the smallest plate jump (usually 2.5 kg). *Travel gym* is for hotel or holiday gyms with machines in lb.
   - **Default Week:** which days you lift, run and do your long run. Adjust it to your week.
   - **Hill Rucks:** leave this off unless you want weighted hill hikes.
   - Click **Save settings**.
2. **Starting point**: when you last climbed, lifted and did a Hill Ruck, so the plan picks up from where you are.
3. **Test Week**: tests your strength for each of the four main lifts (squat, bench press, deadlift, overhead press), to set your **Training Maxes**. Start a Test Week, or if you already know your numbers, enter them in **Training Max**.
4. **Club Events** (optional): climbing sessions with your club or partner. They set your climbing days. Each event is **one dated session** with a date, time, venue and title. Events don't repeat by themselves, so for a weekly session, add one entry per week, e.g. for the next month or two, and top them up now and then.
5. **Trips** (optional): add holidays and trips with their dates and timezone, whether there's a gym, and any mountain days. The plan bends around them.

That's it. From now on:
- **07:00**: Telegram sends the day's sessions. Tap **Done**, **Skip** or **Tomorrow**, then confirm.
- **21:30**: a reminder for the evening mobility routine.
- **Sunday 19:00**: a preview of the week.
- Watch Activities sync about every hour. You can also tap **Sync now**.

Send **/help** to the bot to see every command, e.g. `/log 3h 600m 6` to log a hike your watch missed.

---

## Troubleshooting

| What you see | What to do |
|---|---|
| `command not found: node` or `npm` | Close and reopen the terminal. If that doesn't help, re-install Node.js (Part 2.1). |
| On Windows, `bash` says something about WSL or "no installed distributions" | You're in PowerShell. Open **Git Bash** from the Start menu instead. |
| The wizard shows odd characters like `^[[A` | You pressed an arrow key. Backspace over them, or press Ctrl + C and run the wizard again. |
| "Telegram rejected that token" | Copy the token from BotFather again, the whole line with the colon. In BotFather, `/mybots` → your bot → **API Token** shows it. |
| The wizard keeps asking you to message the bot | Open your bot in Telegram (not BotFather), press **Start** or send *hi*, then press Enter in the terminal. |
| The tracker shows a red banner: *"Not signed in — reload to log in via Cloudflare Access."* | Reload the page once. If the banner comes back, Stage 7 isn't finished. Run the wizard again and redo Stage 7, checking you pasted POLICY_AUD and TEAM_DOMAIN the right way round. |
| The sign-in page doesn't accept your email | In Cloudflare: Zero Trust → Access → Applications → training → Policies. Add your email address. |
| The bot doesn't reply to `/today` | Make sure Access is **off** for *training-bot* (Stage 7 warning), then run the wizard again. Your answers are remembered. |
| "intervals.icu rejected that key" | Generate a new API key in intervals.icu → Settings → Developer Settings and paste it again. |
| Sync now says *"Sync is off: no intervals.icu API key is set"* | You skipped Stage 8. Add the key with the command below. |
| Sync now shows no Activities | Only runs, hikes and climbs from the last 14 days appear. If you have some, check that intervals.icu itself shows them, and that the watch is connected directly rather than through Strava (Part 1.3). |
| "Couldn't reach intervals.icu" | Check your internet connection and try again. |

To add or change the intervals.icu key later, run this from the `app` folder:

```bash
cd ~/training-planner/app
npx wrangler secret put INTERVALS_API_KEY --env=""
```

---

## Updating to a newer version

When a new version is released:

```bash
cd ~/training-planner
git pull
cd app
npm install
npx wrangler d1 migrations apply training --remote
npx wrangler deploy --env=""
npx wrangler deploy --env bot
```

When the migrations command asks *"Ok to proceed?"*, type **y**. If there's nothing new, it says so.

**If `git pull` refuses** with a message mentioning `wrangler.jsonc`, that's because the wizard wrote your own settings into that file. Use this route instead. It takes about 5 minutes, and your settings come back from the wizard's memory:

```bash
cd ~/training-planner
git checkout -- app/wrangler.jsonc
git pull
cd app && npm install && cd ..
bash app/scripts/deploy-wizard.sh
```

In the wizard, press **Enter** to keep each remembered answer. Paste the Telegram token and intervals.icu key again. At Stage 7, skip the dashboard steps (Access is already on) and press Enter to keep the two values.

For the technical version of all this, see [setup.md](setup.md).
