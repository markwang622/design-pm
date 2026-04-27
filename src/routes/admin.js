// ─────────────────────────────────────────────────────────────
// Admin-only destructive operations.
// Currently: factory-reset (wipe DB except current admin + hotel baseline).
// ─────────────────────────────────────────────────────────────
import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);
router.use(requireAdmin);

const RESET_PHRASE = 'DELETE ALL DATA';

const resetSchema = z.object({
  confirm: z.literal(RESET_PHRASE),
  // Extra: admin must re-type their own email so they can't trigger this
  // by accident from another user's session.
  adminEmail: z.string().email(),
});

router.post('/factory-reset', async (req, res) => {
  const parsed = resetSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid_body',
      message: `Body must contain { confirm: "${RESET_PHRASE}", adminEmail: "your-email" }`,
    });
  }

  // Verify the typed email matches the operator's own email
  const me = await prisma.staff.findUnique({
    where: { id: req.user.id },
    select: { id: true, email: true, name: true, role: true, active: true },
  });
  if (!me || me.role !== 'admin' || !me.active) {
    return res.status(403).json({ error: 'forbidden', message: 'Admin only' });
  }
  if (me.email.toLowerCase() !== parsed.data.adminEmail.toLowerCase()) {
    return res.status(403).json({
      error: 'email_mismatch',
      message: '輸入的 Email 跟你登入的 admin 帳號不一致',
    });
  }

  try {
    // Wipe in dependency order. Staff first deletes own foreign keys to
    // notifications/cases via cascade rules, but we explicitly chain to
    // avoid surprises.
    await prisma.$transaction(async (tx) => {
      // Cases-related (these all cascade-delete via Prisma onDelete: Cascade,
      // but be explicit so any future schema changes don't break this).
      await tx.changeLog.deleteMany({});
      await tx.transferLog.deleteMany({});
      await tx.notification.deleteMany({});
      await tx.case.deleteMany({});
      // Availability
      await tx.vacation.deleteMany({});
      await tx.businessTrip.deleteMany({});
      // All non-current-admin staff
      await tx.staff.deleteMany({
        where: { id: { not: me.id } },
      });
      // Hotels — wipe, re-seed baseline
      await tx.hotel.deleteMany({});
      const baseline = [
        { region: '集團', name: '集團本部',     sortOrder: 10 },
        { region: '新竹', name: '新竹湖濱館',   sortOrder: 20 },
        { region: '新竹', name: '新竹都會館',   sortOrder: 30 },
        { region: '台南', name: '台南館',       sortOrder: 40 },
        { region: '宜蘭', name: '宜蘭館',       sortOrder: 50 },
        { region: '宜蘭', name: '傳藝館',       sortOrder: 60 },
        { region: '宜蘭', name: '蘇澳館',       sortOrder: 70 },
        { region: '宜蘭', name: '礁溪館',       sortOrder: 80 },
        { region: '花蓮', name: '花蓮館',       sortOrder: 90 },
        { region: '花蓮', name: '花太館',       sortOrder: 100 },
      ];
      for (const h of baseline) {
        await tx.hotel.create({ data: h });
      }
    });

    res.json({
      ok: true,
      keptAdmin: { id: me.id, name: me.name, email: me.email },
      reseededHotels: 10,
    });
  } catch (e) {
    console.error('[factory-reset] error:', e);
    res.status(500).json({ error: 'reset_failed', message: e.message });
  }
});

export default router;
