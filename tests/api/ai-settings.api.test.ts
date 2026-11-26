import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeEvidenceAnalyzer } from '../support/fakes.js';
import { createOrg, type Org } from '../support/org.js';
import { FILES, lookupIds } from '../support/test-app.js';

/** Settings → AI checks on/off: Learning Team admins switch it, without a server restart. */

let o: Org;
let ai: FakeEvidenceAnalyzer;
let item: string;

const pdf = (marker: string) => Buffer.concat([FILES.pdf, Buffer.from(`\n% ${marker}\n`)]);
const getSettings = (who: { auth: string }) => request(o.t.app).get('/api/v1/settings/ai').set('Authorization', who.auth);
const setChecks = (who: { auth: string }, checksEnabled: unknown) =>
  request(o.t.app).put('/api/v1/settings/ai').set('Authorization', who.auth).send({ checksEnabled });
const upload = (who: { auth: string }, marker: string) =>
  request(o.t.app)
    .put(`/api/v1/me/completions/${item}`)
    .set('Authorization', who.auth)
    .field('completedOn', '2026-02-11')
    .attach('file', pdf(marker), 'certificate.pdf');

beforeAll(async () => {
  // Server default is OFF (as in production); an AI key is configured.
  ai = new FakeEvidenceAnalyzer();
  o = await createOrg({ env: { AI_VERIFICATION_ENABLED: 'false', GEMINI_API_KEY: 'unused-with-fake' }, analyzer: ai });
  const ids = await lookupIds(o.t.db);
  const res = await request(o.t.app)
    .post('/api/v1/items')
    .set('Authorization', o.amina.auth)
    .send({
      title: 'AML annual update',
      provider: 'ICAEW',
      categoryId: ids.categories['Structured CPD'],
      cpdTypeId: ids.cpdTypes['Structured CPD'],
      deliveryTypeId: ids.deliveryTypes['eLearning'],
      hours: 1.5,
      isMandatory: true,
      evidenceMode: 'certificate',
      audience: { all: true },
    });
  item = res.body.data.id as string;
});

afterAll(async () => {
  await o.t.close();
});

describe('AI checks switch', () => {
  it('starts from the server default (off) and tells reviewers', async () => {
    const res = await getSettings(o.elena);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ checksEnabled: false, available: true, source: 'server', provider: 'gemini', updatedBy: null });
  });

  it('while off, uploads wait for a person (no check queued)', async () => {
    const res = await upload(o.sarah, 'off-1');
    expect(res.status).toBe(201);
    expect(res.body.data.check).toBeNull();
    expect(await o.t.container.verificationWorker.tick()).toBe(0);
  });

  it('only Learning Team admins can change it (HR and staff cannot)', async () => {
    expect((await setChecks(o.elena, true)).status).toBe(403);
    expect((await setChecks(o.sarah, true)).status).toBe(403);
    expect((await getSettings(o.sarah)).status).toBe(403);
    expect((await setChecks(o.amina, 'yes')).status).toBe(400);
  });

  it('turning it on takes effect for the next upload, records who and logs it', async () => {
    const res = await setChecks(o.amina, true);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ checksEnabled: true, source: 'settings', updatedBy: 'Amina Patel' });
    expect(res.body.data.updatedAt).toEqual(expect.any(String));

    const up = await upload(o.tomas, 'on-1');
    expect(up.body.data.check).toMatchObject({ status: 'queued' });
    expect(await o.t.container.verificationWorker.tick()).toBe(1);
    expect(ai.calls).toHaveLength(1);

    const audit = await o.t.db.query<{ action: string }>(`select action from audit_events where entity_type = 'ai_settings'`);
    expect(audit.rows.map((r) => r.action)).toEqual(['ai.checks_enabled']);
  });

  it('turning it off hands checks still waiting to the Learning Team (never stuck on "Checking")', async () => {
    const waiting = await upload(o.ibraaheem, 'queued-then-off');
    expect(waiting.body.data.check).toMatchObject({ status: 'queued' }); // not processed yet

    expect((await setChecks(o.amina, false)).status).toBe(200);

    const statuses = await o.t.db.query<{ status: string }>('select status from evidence_checks where completion_id = $1', [waiting.body.data.id]);
    expect(statuses.rows.map((r) => r.status)).toEqual(['superseded']);
    const register = await request(o.t.app).get('/api/v1/completions').set('Authorization', o.amina.auth);
    const row = (register.body.data as { completion: { id: string; check: unknown; reviewStatus: string } }[]).find(
      (r) => r.completion.id === waiting.body.data.id,
    );
    expect(row?.completion).toMatchObject({ check: null, reviewStatus: 'not_reviewed' }); // shows under "Needs review"
    expect(ai.calls).toHaveLength(1); // the AI never read it
  });

  it('turning it off again stops new checks straight away', async () => {
    expect((await setChecks(o.amina, false)).body.data).toMatchObject({ checksEnabled: false, source: 'settings' });
    const up = await upload(o.grace, 'off-2');
    expect(up.body.data.check).toBeNull();
    const recheck = await request(o.t.app).post(`/api/v1/completions/${up.body.data.id}/recheck`).set('Authorization', o.amina.auth);
    expect(recheck.body.code).toBe('VERIFICATION_DISABLED');
  });
});

describe('deployed before the ai_settings table exists (migration not applied yet)', () => {
  let early: Org;
  beforeAll(async () => {
    early = await createOrg({ env: { AI_VERIFICATION_ENABLED: 'false', GEMINI_API_KEY: 'unused-with-fake' }, analyzer: new FakeEvidenceAnalyzer() });
    await early.t.db.query('drop table ai_settings');
  });
  afterAll(async () => {
    await early.t.close();
  });

  it('keeps working on the server default instead of failing', async () => {
    const res = await request(early.t.app).get('/api/v1/settings/ai').set('Authorization', early.elena.auth);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ checksEnabled: false, source: 'server' });
    expect(await early.t.container.verificationWorker.tick()).toBe(0);
  });
});

describe('AI checks switch without an AI key on the server', () => {
  let bare: Org;
  beforeAll(async () => {
    bare = await createOrg();
  });
  afterAll(async () => {
    await bare.t.close();
  });

  it('shows it as not set up and refuses to turn it on', async () => {
    const res = await request(bare.t.app).get('/api/v1/settings/ai').set('Authorization', bare.amina.auth);
    expect(res.body.data).toMatchObject({ checksEnabled: false, available: false });
    const on = await request(bare.t.app).put('/api/v1/settings/ai').set('Authorization', bare.amina.auth).send({ checksEnabled: true });
    expect(on.status).toBeGreaterThanOrEqual(400);
    expect(on.body.code).toBe('AI_NOT_CONFIGURED');
  });
});
