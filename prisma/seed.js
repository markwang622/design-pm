// Explicit empty-database bootstrap. Ordinary server startup must not run seed.
// Existing business data is left untouched, including renamed dictionaries.
import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pathToFileURL } from 'node:url';
import { prisma } from '../src/lib/db.js';
import { ConfigurationError, validateRuntimeConfig, validatePostgresUrl, validateOperatorPassword } from '../src/lib/runtimeConfig.js';
import { taipeiCalendarDay } from '../src/services/analytics.js';

const BUSINESS_MODELS = ['staff', 'case', 'hotel', 'requestUnit', 'meeting', 'meetingAttendee', 'vacation', 'businessTrip', 'shoot', 'changeLog', 'transferLog', 'notification'];
const HOTELS = [
  { region: '集團', name: '集團本部', sortOrder: 10 },
  { region: '新竹', name: '新竹湖濱館', sortOrder: 20 },
  { region: '新竹', name: '新竹都會館', sortOrder: 30 },
  { region: '台南', name: '台南館', sortOrder: 40 },
  { region: '宜蘭', name: '宜蘭館', sortOrder: 50 },
  { region: '宜蘭', name: '傳藝館', sortOrder: 60 },
  { region: '宜蘭', name: '蘇澳館', sortOrder: 70 },
  { region: '宜蘭', name: '礁溪館', sortOrder: 80 },
  { region: '花蓮', name: '花蓮館', sortOrder: 90 },
  { region: '花蓮', name: '花太館', sortOrder: 100 },
];
const UNITS = ['集團執辦', '餐飲行銷', '客房行銷', '客務部', '餐飲部', '採購', '工務', '宜蘭行銷', '花蓮行銷', '嘉義行銷', '台中行銷'];

async function isEmpty(client) {
  // Fast path: an existing installation never needs bootstrap credentials or
  // dictionary reconciliation. The full check also protects partially filled DBs.
  if (await client.staff.count()) return false;
  const counts = await Promise.all(BUSINESS_MODELS.filter(model => model !== 'staff').map(model => client[model].count()));
  return counts.every(count => count === 0);
}

export async function bootstrapDatabase(client = prisma, { env = process.env, hashPassword = bcrypt.hash, now = new Date() } = {}) {
  validateRuntimeConfig(env);
  validatePostgresUrl(env.DATABASE_URL);
  if (!(await isEmpty(client))) return { skipped: true, reason: 'database_not_empty' };
  if (env.BOOTSTRAP_EMPTY_DATABASE !== 'yes') {
    throw new ConfigurationError('BOOTSTRAP_EMPTY_DATABASE', 'empty database bootstrap is manual; set BOOTSTRAP_EMPTY_DATABASE=yes only for the verified fresh target');
  }
  const email = z.string().email().safeParse(env.SEED_ADMIN_EMAIL);
  if (!email.success) throw new ConfigurationError('SEED_ADMIN_EMAIL', 'set the administrator email explicitly before bootstrap');
  const name = env.SEED_ADMIN_NAME === undefined ? 'Administrator' : env.SEED_ADMIN_NAME.trim();
  if (!name || name.length > 100) throw new ConfigurationError('SEED_ADMIN_NAME', 'set a nonempty administrator name of at most 100 characters');
  const password = validateOperatorPassword(env.SEED_ADMIN_PASSWORD);
  const passwordHash = await hashPassword(password, 12);
  try {
    return await client.$transaction(async tx => {
      if (!(await isEmpty(tx))) return { skipped: true, reason: 'database_not_empty' };
      await tx.hotel.createMany({ data: HOTELS });
      await tx.requestUnit.createMany({ data: UNITS.map((unit, index) => ({ name: unit, sortOrder: (index + 1) * 10 })) });
      await tx.staff.create({ data: { name, email: email.data, password: passwordHash, role: 'admin', roleTitle: '管理員', seniority: 'senior', joined: taipeiCalendarDay(now), active: true, pendingActivation: false } });
      return { skipped: false, staff: 1, hotels: HOTELS.length, requestUnits: UNITS.length, cases: 0 };
    }, { isolationLevel: 'Serializable', maxWait: 5000, timeout: 30000 });
  } catch (e) {
    if (e.code === 'P2034') throw new ConfigurationError('BOOTSTRAP_EMPTY_DATABASE', 'database changed during bootstrap; no bootstrap data committed, verify the target and retry');
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  bootstrapDatabase()
    .then(result => console.log(result.skipped ? '[seed] Existing business data detected; bootstrap skipped without changes.' : '[seed] Empty database initialized with one administrator and dictionaries; no sample cases or credential output.'))
    .catch(e => { console.error('[seed]', e instanceof ConfigurationError ? e.message : 'Bootstrap failed; transaction rolled back. Check database availability and migration status.'); process.exitCode = 1; })
    .finally(() => prisma.$disconnect());
}
