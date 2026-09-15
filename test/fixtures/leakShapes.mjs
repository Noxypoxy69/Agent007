/**
 * EVERY SHAPE THAT MUST NOT BE PUBLISHED, AS DATA.
 *
 * SYNTHETIC ONLY, AND THAT IS A SECURITY PROPERTY, NOT A STYLE CHOICE. The
 * operator here is "Jane Doe" on "DESKTOP-ABC123" and does not exist. A fixture
 * built from a real collected payload would put the real operator's name into
 * the repository permanently — committed, pushed, and present in every clone
 * and every future checkout. The guard these fixtures exercise exists to stop
 * exactly that disclosure; carrying it in the test data would be the leak, with
 * the added insult of being the one thing git never forgets.
 *
 * A real payload may still be SCANNED — ephemerally, from a temp file, never
 * added to the index. leakRegression.test.mjs does that and asserts only counts.
 *
 * WHY A SEPARATE FILE. The shapes are data and the assertions are code, and
 * keeping them apart means a new leak shape is one entry here rather than a new
 * test nobody writes. Each carries the reason it exists, because a shape whose
 * reason is lost gets deleted by the next person who finds it inconvenient.
 */

export const OPERATOR = {
  username: 'Jane Doe',
  homedir: 'C:\\Users\\Jane Doe',
  hostname: 'DESKTOP-ABC123',
};

/** A username with no space, for the case where parts and whole are the same. */
export const SINGLE_WORD_OPERATOR = {
  username: 'jdoe',
  homedir: 'C:\\Users\\jdoe',
  hostname: 'build-box-7',
};

/**
 * MUST LEAK. Each entry is {what, value, why} — `why` is the sentence a future
 * reader needs when they are tempted to delete the case.
 */
export const MUST_LEAK = [
  {
    what: 'windows home path, long form',
    value: 'C:\\Users\\Jane Doe\\Documents\\social-sparks-app',
    why: 'leak 1 as it actually shipped: the operator name, twice per session',
  },
  {
    what: 'the SAME path with forward slashes',
    value: 'C:/Users/Jane Doe/Documents/social-sparks-app',
    why: 'leak 2. git and the OS disagree about separators, so one directory has two spellings and handling one looks exactly like working redaction',
  },
  {
    what: 'windows home path, lower case',
    value: 'c:\\users\\jane doe\\documents\\x',
    why: 'Windows paths are case-insensitive; a case-sensitive comparison misses half of them',
  },
  {
    what: 'machine label built from a first name',
    value: 'jane-win',
    why: 'leak 3 as it shipped ("danny-win"). The whole username does not appear in it, so a full-name substring test scans it clean',
  },
  {
    what: 'hostname',
    value: 'DESKTOP-ABC123',
    why: 'leak 3, the other half',
  },
  {
    what: 'hostname in a sentence',
    value: 'collected on DESKTOP-ABC123 at 04:12',
    why: 'identity arrives inside prose, not only in a dedicated field',
  },
  {
    what: 'absolute path with no name in it',
    value: 'D:\\build\\artifacts\\out',
    why: 'discloses the shape of somebody disk to a reader with no business knowing it, and is the carrier every identity leak has travelled inside',
  },
  {
    what: 'posix home path',
    value: '/home/jdoe/src/app',
    why: 'the same leak on the platform CI runs on',
  },
  {
    what: 'macOS home path',
    value: '/Users/jdoe/src/app',
    why: 'as above; /Users is not only a Windows-ism',
  },
  {
    what: 'absolute path embedded in an error message',
    value: 'ENOENT: no such file, open C:\\Users\\Jane Doe\\.env.local',
    why: 'a stack trace is exactly where a path arrives without anyone intending it',
  },
  {
    what: 'absolute worktree path',
    value: 'C:\\Users\\Jane Doe\\Documents\\agentbridge-b3',
    why: 'sessions[].worktree published this verbatim; found live by the publish guard on 15 Sep',
  },
  {
    what: 'github token',
    value: `ghp_${'a'.repeat(30)}`,
    why: 'a credential in a payload is a credential in a hosted database',
  },
  {
    what: 'slack token',
    value: 'xoxb-4827361-9182736450-aBcDeFgHiJkLmNoPqRsT',
    why: 'as above, different prefix',
  },
  {
    what: 'aws access key id',
    value: 'AKIAQ7X2M4NPLVE3KD9B',
    why: 'as above',
  },
  {
    what: 'credentials embedded in a URL',
    value: 'https://deploy:hunter2hunter2@git.example.com/org/repo.git',
    why: 'a remote URL can carry a password, and looks like an ordinary URL',
  },
  {
    what: 'a bearer token inside a quoted command line',
    value: `curl -H "Authorization: Bearer ${'z'.repeat(44)}" https://api.example.com`,
    why: 'a quote-aware tokeniser keeps this as ONE token containing spaces and a colon, which matches no credential shape — the secret hides from the splitter that was correct for reading a command line',
  },
];

/**
 * MUST NOT LEAK. The silent half, and the half that decides whether anybody
 * keeps the guard: a scanner that flags every string passes every fires-test
 * and is removed from the publish path within a day.
 */
export const MUST_NOT_LEAK = [
  { what: 'git object id, full', value: 'ad4fc1af5d00ab3d5a2895e69476472daa8dd9c8', why: 'a heartbeat is mostly commit SHAs; flagging them makes the guard noise on its first run' },
  { what: 'git object id, short', value: 'b9623ac', why: 'as above' },
  { what: 'v4 uuid', value: '62710e7e-09b5-48f8-b15c-f790be308b86', why: 'machine.id exists precisely so the payload names nobody; flagging the anonymising identifier is how a guard loses its reader' },
  { what: 'branch name', value: 'b/leak-regression', why: 'ordinary payload content' },
  { what: 'lane id', value: 'onboarding', why: 'ordinary payload content' },
  { what: 'semver', value: '0.2.0', why: 'ordinary payload content' },
  { what: 'iso timestamp', value: '2026-09-15T04:39:21.018Z', why: 'ordinary payload content' },
  { what: 'relative posix path', value: 'src/lib/payloadGuard.mjs', why: 'names no disk and no person' },
  { what: 'relative windows path', value: 'test\\fixtures\\leakShapes.mjs', why: 'as above' },
  { what: 'tilde-relative path', value: '~\\Documents\\x', why: 'deliberately anonymous already' },
  { what: 'tilde-relative posix path', value: '~/Documents/x', why: 'as above' },
  { what: 'plain https remote', value: 'https://github.com/owner/repo.git', why: 'an unanchored drive-letter pattern matches the "s:/" inside "https://" — this pins that regression' },
  { what: 'ssh remote', value: 'git@github.com:owner/repo.git', why: 'as above, different shape' },
  { what: 'opaque machine name', value: 'machine-62710e', why: 'the anonymised label; must survive' },
  { what: 'an ordinary word containing a name part', value: "it doesn't build", why: '"doe" sits inside "doesn\'t" — without a boundary rule the guard fires on ordinary English' },
  { what: 'another word containing a name part', value: 'janitorial supplies', why: 'as above' },
  { what: 'a short english sentence', value: 'the runner finished in 4s', why: 'the baseline: prose must scan clean' },
];

/**
 * A payload shaped like the real one, carrying every MUST_LEAK value at a
 * different depth — inside arrays, inside nested objects, and as a bare
 * top-level string.
 *
 * Depth is the point. All three real leaks were in fields nobody thought to
 * check, so a suite that only tests top-level keys proves nothing about the
 * walk that actually matters.
 */
export function leakyPayload() {
  return {
    schema: 'agentbridge.heartbeat.v1',
    sentAt: '2026-09-15T04:39:21.018Z',
    machine: { id: '62710e7e-09b5-48f8-b15c-f790be308b86', label: 'jane-win', hostname: 'DESKTOP-ABC123' },
    sessions: MUST_LEAK.map((c, i) => ({
      agentId: `agent-${i}`,
      lane: 'onboarding',
      worktree: c.value,
      git: { head: 'ad4fc1a', branch: 'b/leak-regression', note: { deeper: [{ deepest: c.value }] } },
    })),
  };
}

/** The same shape carrying only MUST_NOT_LEAK values. Must scan completely clean. */
export function cleanPayload() {
  return {
    schema: 'agentbridge.heartbeat.v1',
    sentAt: '2026-09-15T04:39:21.018Z',
    machine: { id: '62710e7e-09b5-48f8-b15c-f790be308b86', name: 'machine-62710e', platform: 'win32' },
    sessions: MUST_NOT_LEAK.map((c, i) => ({
      agentId: `agent-${i}`,
      lane: 'onboarding',
      note: c.value,
      git: { head: 'b9623ac', branch: 'b/leak-regression', nested: [{ deep: c.value }] },
    })),
  };
}
