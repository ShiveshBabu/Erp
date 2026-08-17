const BASE = 'http://localhost:4000';
const PASS = process.env.DEV_SEED_PASSWORD || 'ChangeMe123!';

async function fetchCsrf(cookie) {
  const res = await fetch(BASE + '/api/v1/auth/csrf-token', { headers: cookie ? { Cookie: cookie } : {} });
  const setCookie = (res.headers.get('set-cookie') || '').split(';')[0];
  const body = await res.json();
  return { cookie: cookie || setCookie, token: body.data.csrfToken };
}

let pass = 0, fail = 0;
function check(name, cond, detail) { if (cond) { pass++; console.log('PASS:', name); } else { fail++; console.log('FAIL:', name, detail !== undefined ? JSON.stringify(detail).slice(0, 200) : ''); } }

async function main() {
  // ---- Tier: health/CSRF endpoint should tolerate a rapid burst (generous allowance) ----
  let healthOk = 0;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(BASE + '/health');
    if (r.status === 200) healthOk++;
  }
  check('Health endpoint tolerates a 20-request burst without throttling', healthOk === 20, healthOk);

  let csrfOk = 0;
  for (let i = 0; i < 20; i++) {
    const r = await fetch(BASE + '/api/v1/auth/csrf-token');
    if (r.status === 200) csrfOk++;
  }
  check('CSRF token endpoint tolerates a 20-request burst without throttling', csrfOk === 20, csrfOk);

  // ---- Tier: login is strict (max 10/min per this config) — 11th attempt in the same window should 429 ----
  let loginThrottled = false;
  let successfulLogins = 0;
  for (let i = 0; i < 12; i++) {
    const pre = await fetchCsrf(null);
    const res = await fetch(BASE + '/api/v1/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: pre.cookie, 'x-csrf-token': pre.token },
      body: JSON.stringify({ usernameOrEmail: 'ravi.velan', password: 'deliberately-wrong-password' })
    });
    if (res.status === 429) { loginThrottled = true; break; }
    if (res.status < 300) successfulLogins++;
  }
  check('Login is strictly rate-limited (throttles well before 12 rapid attempts)', loginThrottled, { successfulLogins });

  console.log(`\n=== TIERED RATE LIMIT TESTS: ${pass}/${pass + fail} passed ===`);
  process.exit(fail > 0 ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
