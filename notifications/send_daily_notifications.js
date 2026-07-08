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

  // ── #1 — defend your crown ──────────────────────────────────────────────────
  if (rank === 1) {
    return pick([
      { title: "👑 You're on top!", body: `You're #1 on the PEG leaderboard, ${name}! Keep playing to defend your crown.` },
      { title: '🔥 Undefeated Leader!', body: `${name}, you're still the #1 player! Don't let anyone catch up — play now.` },
      { title: '🏆 Still #1!', body: `No one has beaten you yet, ${name}. Stay on top — open PEG and dominate!` },
    ]);
  }

  // ── Top 3 — so close to #1 ──────────────────────────────────────────────────
  if (rank <= 3) {
    const aboveName = abovePlayer?.nickname || 'someone';
    return pick([
      { title: `🥇 So close to #1, ${name}!`, body: `${aboveName} is just ahead at #${rank - 1}. Play now and take the top spot! 🎮` },
      { title: `⚡ One game away from glory!`, body: `You're at #${rank}. ${aboveName} is just above you — challenge them now!` },
    ]);
  }

  // ── Someone is beating the player ───────────────────────────────────────────
  if (abovePlayer) {
    const aboveName = abovePlayer.nickname || 'Another player';
    return pick([
      { title: `😤 ${aboveName} is ahead of you!`, body: `${aboveName} knocked you to #${rank}. Open PEG and take back your spot! 🎯` },
      { title: `⚔️ You're being overtaken!`, body: `${aboveName} is now ranked #${rank - 1}. Don't let them stay ahead — play now!` },
      { title: `🔔 Rank Alert, ${name}!`, body: `You're at #${rank} and ${aboveName} is beating you. Fight back in PEG! 💪` },
    ]);
  }

  // ── Generic motivator ────────────────────────────────────────────────────────
  return pick([
    { title: `🎮 Time to play, ${name}!`, body: `You're ranked #${rank} of ${totalPlayers}. Climb higher — open PEG now!` },
    { title: `📈 Keep climbing, ${name}!`, body: `Your rank is #${rank}. One game could move you up. Let's go! 🚀` },
    { title: `🏅 Daily Challenge Awaits!`, body: `${name}, your rank is #${rank}. Jump in and earn more XP today!` },
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

  // Build user list with XP computed client-side (same formula as Flutter app)
  const users = snapshot.docs.map(doc => {
    const d = doc.data();
    return {
      uid:        doc.id,
      nickname:   d.nickname   || 'Player',
      totalScore: d.totalScore || 0,
      gamesWon:   d.gamesWon   || 0,
      fcmToken:   d.fcmToken,
      xp:         (d.totalScore || 0) + (d.gamesWon || 0) * 15,
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
