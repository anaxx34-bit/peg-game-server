#!/usr/bin/env node
/**
 * PEG Game — Daily Motivational Push Notification Script
 *
 * Runs via GitHub Actions every day at 1:30 PM UTC (7 PM IST).
 * Reads leaderboard from Firestore, builds a personalised message
 * for each user, and sends it via FCM using the Firebase Admin SDK.
 *
 * Required env var (GitHub Secret):
 *   FIREBASE_SERVICE_ACCOUNT_JSON  — full JSON of Firebase service account key
 */

const admin = require('firebase-admin');

// ── Firebase Init ─────────────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });

const db  = admin.firestore();
const fcm = admin.messaging();

// ── Message Builder ───────────────────────────────────────────────────────────

/** Returns a random element from an array. */
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Build a personalised motivational message for [player] at [rank].
 * [abovePlayer] is the player ranked one above them (or null if rank === 1).
 */
function buildMessage(player, abovePlayer, rank, totalPlayers) {
  const name = player.nickname || 'Player';
  const xp = player.xp;
  const gamesPlayed = player.gamesPlayed;
  const gamesWon = player.gamesWon;
  const loginStreak = player.loginStreak;

  // 1. New Player (0 games played)
  if (gamesPlayed === 0) {
    return pick([
      { title: `🎲 Welcome to PEG, ${name}!`, body: "Ready to roll? Play your very first match and start climbing the leaderboard! 🚀" },
      { title: `🎮 Start your journey, ${name}!`, body: "Learn the rules and win your first game. Play now! 🏆" },
      { title: `⚡ Tap to Play!`, body: "Your board is waiting. Roll the dice and collect pegs to level up!" },
    ]);
  }

  // 2. No wins yet
  if (gamesWon === 0) {
    return pick([
      { title: `🎯 Ready for your first win, ${name}?`, body: `You've played ${gamesPlayed} matches. Keep trying — your first victory is close! 🏆` },
      { title: `⚔️ Challenge a Bot, ${name}!`, body: "Practice your strategy against the AI and unlock new levels!" },
    ]);
  }

  // 3. Keep streak alive (if they have a login streak >= 2)
  if (loginStreak >= 2) {
    return { 
      title: `🔥 Streak Alert, ${name}!`, 
      body: `Keep your ${loginStreak}-day login streak alive! Log in now and claim your daily reward. 💎` 
    };
  }

  // 4. Player has real XP and is #1
  if (rank === 1 && xp > 0) {
    return pick([
      { title: "👑 You're the Champion!", body: `You're #1 on the global leaderboard with ${xp} XP, ${name}! Defend your title now.` },
      { title: '🏆 Global Leader!', body: `${name}, you're still ruling the board. Open PEG and play to keep your crown!` },
    ]);
  }

  // 5. Close competitor ahead (Top 3)
  if (rank <= 3 && abovePlayer && xp > 0) {
    const aboveName = abovePlayer.nickname || 'Someone';
    const xpDiff = abovePlayer.xp - xp;
    return pick([
      { title: `🥇 So close to #1, ${name}!`, body: `${aboveName} is at #${rank - 1} with ${abovePlayer.xp} XP. Play now to overtake them! 🎮` },
      { title: `⚡ Just ${xpDiff} XP away!`, body: `You need only ${xpDiff} XP to beat ${aboveName} and rank up. Go for it! 🚀` },
    ]);
  }

  // 6. Overtaken rank alert (if they have real XP)
  if (abovePlayer && xp > 0) {
    const aboveName = abovePlayer.nickname || 'Another player';
    return pick([
      { title: `😤 Overtake Alert, ${name}!`, body: `${aboveName} is ranked #${rank - 1} with ${abovePlayer.xp} XP. Beat their score! 🎯` },
      { title: `⚔️ Climb the ranks!`, body: `You are currently #${rank}. Open PEG and play a match to boost your level! 💪` },
    ]);
  }

  // 7. Generic Motivator
  return pick([
    { title: `🎮 Time to play, ${name}!`, body: `You're ranked #${rank} out of ${totalPlayers} players. Climb higher — open PEG now!` },
    { title: `📈 Keep climbing, ${name}!`, body: `With ${xp} XP, you are at rank #${rank}. One win could move you up! Let's go! 🚀` },
    { title: `🏅 Challenge of the Day!`, body: `${name}, open PEG now to check today's daily quests and earn coins!` },
  ]);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function sendDailyNotifications() {
  console.log('[PEG Notif] Fetching users with FCM tokens from Firestore...');

  // Fetch all users that have an fcmToken saved
  const snapshot = await db
    .collection('users')
    .where('fcmToken', '!=', null)
    .orderBy('fcmToken')   // Firestore requires orderBy when using != filter
    .get();

  if (snapshot.empty) {
    console.log('[PEG Notif] No users with FCM tokens found. Exiting.');
    return;
  }

  // Build user list with XP computed client-side
  const users = snapshot.docs.map(doc => {
    const d = doc.data();
    const totalScore = parseInt(d.totalScore) || 0;
    const gamesWon = parseInt(d.gamesWon) || 0;
    const xp = parseInt(d.customXp ?? d.xp) || (totalScore + gamesWon * 15);
    
    return {
      uid:         doc.id,
      nickname:    d.nickname || 'Player',
      totalScore:  totalScore,
      gamesWon:    gamesWon,
      gamesPlayed: parseInt(d.gamesPlayed) || 0,
      fcmToken:    d.fcmToken,
      xp:          xp,
      loginStreak: parseInt(d.loginStreak) || 0,
      level:       parseInt(d.level) || 1,
    };
  });

  // Sort by XP descending (same as leaderboard in app)
  users.sort((a, b) => b.xp - a.xp);

  const total = users.length;
  console.log(`[PEG Notif] ${total} notifiable players. Sending...`);

  let sent = 0, failed = 0;

  for (let i = 0; i < users.length; i++) {
    const player      = users[i];
    const rank        = i + 1;
    const abovePlayer = i > 0 ? users[i - 1] : null;

    const { title, body } = buildMessage(player, abovePlayer, rank, total);

    try {
      await fcm.send({
        token: player.fcmToken,
        notification: { title, body },
        android: {
          notification: {
            channelId: 'peg_streak_channel',  // must match Flutter channel
            icon: '@mipmap/launcher_icon',
            priority: 'high',
          },
          priority: 'high',
        },
        apns: {
          payload: { aps: { sound: 'default', badge: 1 } },
        },
        data: {
          type: 'daily_motivation',
          rank: String(rank),
          click_action: 'FLUTTER_NOTIFICATION_CLICK',
        },
      });

      console.log(`  ✅ ${player.nickname} (rank #${rank}): "${title}"`);
      sent++;
    } catch (err) {
      console.warn(`  ❌ ${player.nickname}: ${err.message}`);

      // Remove stale / invalid tokens to keep Firestore clean
      if (
        err.code === 'messaging/invalid-registration-token' ||
        err.code === 'messaging/registration-token-not-registered'
      ) {
        await db
          .collection('users')
          .doc(player.uid)
          .update({ fcmToken: admin.firestore.FieldValue.delete() })
          .catch(() => {});
        console.log(`  🗑️  Removed stale token for ${player.nickname}`);
      }
      failed++;
    }
  }

  console.log(`\n[PEG Notif] Done — ${sent} sent, ${failed} failed.`);
}

// Run
sendDailyNotifications().catch(err => {
  console.error('[PEG Notif] Fatal error:', err);
  process.exit(1);
});
