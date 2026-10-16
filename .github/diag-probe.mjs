// Temporary: probe candidate ATS identifiers. Removed before merge.
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36' };
const t = (ms) => AbortSignal.timeout(ms);

async function gh(slug) {
  const r = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, { headers: UA, signal: t(15000) });
  if (!r.ok) return null;
  const b = await r.json().catch(() => null);
  if (!Array.isArray(b?.jobs)) return null;
  const meta = await fetch(`https://boards-api.greenhouse.io/v1/boards/${slug}`, { headers: UA, signal: t(15000) })
    .then((x) => x.json()).catch(() => ({}));
  return `${b.jobs.length} jobs, board name "${meta.name || '?'}", e.g. ${b.jobs.slice(0, 2).map((j) => j.title).join(' | ')}`;
}
async function lever(slug) {
  const r = await fetch(`https://api.lever.co/v0/postings/${slug}?mode=json`, { headers: UA, signal: t(15000) });
  if (!r.ok) return null;
  const b = await r.json().catch(() => null);
  return Array.isArray(b) ? `${b.length} jobs, e.g. ${b.slice(0, 2).map((j) => j.text).join(' | ')}` : null;
}
async function ashby(slug) {
  const r = await fetch(`https://api.ashbyhq.com/posting-api/job-board/${slug}`, { headers: UA, signal: t(15000) });
  if (!r.ok) return null;
  const b = await r.json().catch(() => null);
  return Array.isArray(b?.jobs) ? `${b.jobs.length} jobs, e.g. ${b.jobs.slice(0, 2).map((j) => j.title).join(' | ')}` : null;
}
async function workday(host, site) {
  const tenant = host.split('.')[0];
  const r = await fetch(`https://${host}/wday/cxs/${tenant}/${site}/jobs`, {
    method: 'POST', signal: t(15000),
    headers: { ...UA, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: 0, searchText: '' }),
  });
  if (!r.ok) return null;
  const b = await r.json().catch(() => null);
  return Array.isArray(b?.jobPostings) ? `${b.total} jobs, e.g. ${b.jobPostings.slice(0, 2).map((j) => j.title).join(' | ')}` : null;
}
async function page(url) {
  try {
    const r = await fetch(url, { headers: UA, redirect: 'follow', signal: t(15000) });
    const html = await r.text();
    const hits = [...new Set((html.match(/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?[A-Za-z0-9_-]+|jobs\.lever\.co\/[A-Za-z0-9_-]+|jobs\.ashbyhq\.com\/[A-Za-z0-9_.-]+|[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/[A-Za-z0-9_\/-]+|for=[A-Za-z0-9_-]+/g) || []))];
    return `HTTP ${r.status} → ${r.url}\n      ${hits.slice(0, 8).join('\n      ') || '(no ATS references in page)'}`;
  } catch (e) { return 'fetch failed: ' + e.message; }
}

const SLUGS = {
  'FirstKey Homes': ['firstkeyhomes', 'firstkey', 'firstkeyhomesllc', 'firstkeyhomes1', 'fkh'],
  'Kasa Living': ['kasaliving', 'kasa', 'kasalivinginc', 'kasa1'],
  'Realtor.com': ['rdccareers', 'realtorcom', 'realtor', 'moveinc', 'move'],
  'OJO Labs': ['ojolabs', 'ojo', 'ojocareers', 'ojolabsinc'],
  'Bilt Rewards': ['biltrewards', 'bilt', 'biltcareers', 'biltrewardsinc'],
  'Placer.ai': ['placerai', 'placer', 'placerlabs', 'placeraiinc'],
  'Mynd': ['mynd', 'myndmanagement', 'myndpropertymanagement', 'myndco'],
  'Lineage': ['lineagehq', 'lineage', 'lineagelogistics', 'lineageinc'],
  'Main Street Renewal': ['mainstreetrenewal', 'msr', 'mainstreet'],
  'Measurabl': ['measurabl'], 'HouseCanary': ['housecanary'], 'Apartment List': ['apartmentlist'],
  'Hemlane': ['hemlane'], 'Cherre': ['cherre'], 'Rhino': ['sayrhino', 'rhino', 'rhinoinc'],
  'Guesty': ['guesty'], 'Updater': ['updater'], 'HqO': ['hqo', 'hqoinc'], 'Robin': ['robinpowered', 'robin'],
  'Latch': ['latch', 'latchinc', 'door'], 'Density': ['density'], 'DoorLoop': ['doorloop'],
  'LeaseLock': ['leaselock'], 'Placester': ['placester'], 'Proof': ['proof', 'notarize'],
  'Worksmith': ['worksmith'], 'ResMan': ['resman', 'myresman'], 'Auction.com': ['auctioncom', 'auction'],
  'Pathway Homes': ['pathwayhomes', 'pathway'], 'Agora': ['agora', 'agorareal', 'agora-re'],
  'SquareFoot': ['squarefoot', 'thesquarefoot'], 'GetCovered': ['getcovered'], 'Knock': ['knockcrm', 'knock'],
  'Yieldstreet (Cadre)': ['yieldstreet'], 'Maymont Homes (Divvy)': ['maymonthomes', 'maymont'],
  'Esusu': ['esusu'], 'Livly': ['livly'], 'Obie': ['obie', 'obieinsurance'], 'Closinglock': ['closinglock'],
  'Procore': ['procore', 'procoretechnologies'], 'Reffie': ['reffie'],
};

console.log('=== Greenhouse / Lever / Ashby candidates ===');
for (const [name, slugs] of Object.entries(SLUGS)) {
  const found = [];
  for (const s of slugs) {
    for (const [ats, fn] of [['greenhouse', gh], ['lever', lever], ['ashby', ashby]]) {
      const r = await fn(s).catch(() => null);
      if (r) found.push(`${ats}:${s} — ${r}`);
    }
  }
  console.log(`${name}: ${found.length ? '\n    ' + found.join('\n    ') : 'nothing'}`);
}

console.log('\n=== Workday sites ===');
const WD = {
  'amherstgroup.wd1.myworkdayjobs.com': ['External', 'Amherst', 'AmherstCareers', 'Amherst_Careers', 'Careers', 'AmherstGroup', 'Amherst_External', 'External_Careers', 'MSR', 'MainStreetRenewal'],
  'chamberlain.wd1.myworkdayjobs.com': ['Chamberlain_Group', 'ChamberlainGroup', 'External', 'Careers', 'Chamberlain', 'CGI', 'chamberlain_careers', 'External_Careers'],
};
for (const [host, sites] of Object.entries(WD)) {
  for (const s of sites) {
    const r = await workday(host, s).catch(() => null);
    if (r) console.log(`${host} site ${s}: ${r}`);
  }
  const root = await fetch(`https://${host}/`, { headers: UA, redirect: 'follow', signal: t(15000) }).catch(() => null);
  console.log(`${host} root → ${root ? root.status + ' ' + root.url : 'failed'}`);
}

console.log('\n=== Careers pages: ATS references ===');
const PAGES = {
  'FirstKey Homes': 'https://www.firstkeyhomes.com/careers',
  'Main Street Renewal': 'https://www.mainstreetrenewal.com/careers',
  'Amherst': 'https://www.amherst.com/careers',
  'Chamberlain': 'https://chamberlaingroup.com/careers',
  'Placer.ai': 'https://www.placer.ai/company/we-are-hiring/',
  'Kasa': 'https://www.kasa.com/careers',
  'Bilt': 'https://www.biltrewards.com/careers',
  'Mynd': 'https://www.mynd.co/careers',
  'AMH': 'https://www.amh.com/careers',
  'AMH Oracle': 'https://ejpe.fa.us6.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/requisitions',
  'Lineage': 'https://www.lineagehq.com/careers',
};
for (const [name, url] of Object.entries(PAGES)) console.log(`${name}: ${await page(url)}`);
