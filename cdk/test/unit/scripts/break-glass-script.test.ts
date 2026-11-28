import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// scripts/break-glass.sh against a fake `aws`: it records what each call was given (arguments and which credentials were
// in the environment), and answers with canned text. What the script has to get right is which credentials go where.
const SCRIPT = path.resolve(__dirname, '../../../../scripts/break-glass.sh');

const FAKE_AWS = `#!/usr/bin/env bash
echo "$*|key=\${AWS_ACCESS_KEY_ID:-none}|profile=\${AWS_PROFILE:-none}" >> "$FAKE_LOG"
case "$1 $2" in
  "cloudformation describe-stacks")
    case "$*" in
      *BreakGlassRoleArn*) echo "arn:aws:iam::111111111111:role/TAK-Test-CloudTAK-BreakGlass" ;;
      *BreakGlassSecretName*) echo "TAK-Test-CloudTAK/API/Admin-Password" ;;
      *BreakGlassRotateFunction*) echo "TAK-Test-CloudTAK-BreakGlassRotate" ;;
    esac ;;
  "iam list-mfa-devices") echo "arn:aws:iam::111111111111:mfa/tester" ;;
  "sts get-caller-identity") echo "arn:aws:iam::111111111111:user/tester" ;;
  "sts assume-role") printf 'ROLEKEY\\tROLESECRET\\tROLETOKEN\\t2026-11-28T06:00:00+00:00\\n' ;;
  "secretsmanager get-secret-value") echo '{"username":"ckadmin","password":"s3cretPassw0rd"}' ;;
  "lambda invoke")
    out="\${@: -1}"; echo '{"status":"rotated","secretVersion":"v123"}' > "$out" ;;
esac
`;

function run(args: string[], env: Record<string, string> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-'));
  fs.writeFileSync(path.join(dir, 'aws'), FAKE_AWS, { mode: 0o755 });
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  const result = spawnSync('bash', [SCRIPT, ...args], {
    env: { PATH: `${dir}:${process.env.PATH}`, HOME: dir, FAKE_LOG: log, AWS_ACCESS_KEY_ID: 'CALLERKEY', ...env },
    encoding: 'utf8'
  });
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean);
  return { ...result, calls };
}

describe('scripts/break-glass.sh', () => {
  test('read: assumes the role with MFA, reads the secret as the role, prints the credential on stdout only', () => {
    const r = run(['TAK-Test-CloudTAK', 'read', '--token-code', '123456']);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('username: ckadmin\npassword: s3cretPassw0rd\n');
    expect(r.stderr).not.toContain('s3cretPassw0rd');
    const assume = r.calls.find((c) => c.startsWith('sts assume-role'))!;
    expect(assume).toContain('--role-arn arn:aws:iam::111111111111:role/TAK-Test-CloudTAK-BreakGlass');
    expect(assume).toContain('--serial-number arn:aws:iam::111111111111:mfa/tester');
    expect(assume).toContain('--token-code 123456');
    expect(assume).toContain('--duration-seconds 900');
    expect(assume).toContain('--role-session-name break-glass-tester');
    // the assume-role call is made with the caller's own credentials
    expect(assume).toContain('key=CALLERKEY');
    // and only the secret read uses the role's keys
    const withRole = r.calls.filter((c) => c.includes('key=ROLEKEY'));
    expect(withRole).toHaveLength(1);
    expect(withRole[0]).toContain('secretsmanager get-secret-value');
    expect(withRole[0]).toContain('--secret-id TAK-Test-CloudTAK/API/Admin-Password');
  });

  test('a profile in the environment (an Identity Center login) is kept for the caller and removed for the role', () => {
    const r = run(['TAK-Test-CloudTAK', 'read', '--no-mfa'], { AWS_PROFILE: 'sso-admin' });
    expect(r.status).toBe(0);
    expect(r.calls.find((c) => c.startsWith('sts assume-role'))).toContain('profile=sso-admin');
    expect(r.calls.find((c) => c.includes('secretsmanager get-secret-value'))).toContain('profile=none');
  });

  test('--no-mfa leaves out the MFA arguments and does not look for a device', () => {
    const r = run(['TAK-Test-CloudTAK', 'read', '--no-mfa']);
    expect(r.status).toBe(0);
    const assume = r.calls.find((c) => c.startsWith('sts assume-role'))!;
    expect(assume).not.toContain('--serial-number');
    expect(assume).not.toContain('--token-code');
    expect(r.calls.some((c) => c.startsWith('iam list-mfa-devices'))).toBe(false);
  });

  test('rotate: looks the function up as the caller, invokes it as the role, and says to restart LDAP', () => {
    const r = run(['TAK-Test-CloudTAK', 'rotate', '--no-mfa']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"status":"rotated"');
    const lookup = r.calls.find((c) => c.includes('BreakGlassRotateFunction'))!;
    expect(lookup).toContain('key=CALLERKEY');
    const invoke = r.calls.find((c) => c.startsWith('lambda invoke'))!;
    expect(invoke).toContain('--function-name TAK-Test-CloudTAK-BreakGlassRotate');
    expect(invoke).toContain('key=ROLEKEY');
    expect(r.stderr).toContain('restart the LDAP service');
  });

  test('credentials: prints export lines and unsets the profile, nothing else on stdout', () => {
    const r = run(['TAK-Test-CloudTAK', 'credentials', '--no-mfa']);
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'unset AWS_PROFILE',
      "export AWS_ACCESS_KEY_ID='ROLEKEY'",
      "export AWS_SECRET_ACCESS_KEY='ROLESECRET'",
      "export AWS_SESSION_TOKEN='ROLETOKEN'"
    ]);
  });

  test('refuses a code that is not six digits, and a duration out of range, before calling AWS', () => {
    const code = run(['TAK-Test-CloudTAK', 'read', '--token-code', '12']);
    expect(code.status).not.toBe(0);
    expect(code.stderr).toContain('6 digits');
    expect(code.calls.some((c) => c.startsWith('sts assume-role'))).toBe(false);
    const duration = run(['TAK-Test-CloudTAK', 'read', '--no-mfa', '--duration', '60']);
    expect(duration.status).not.toBe(0);
    expect(duration.calls).toHaveLength(0);
  });

  test('prints the usage for no arguments or an unknown command', () => {
    expect(run([]).status).toBe(2);
    const unknown = run(['TAK-Test-CloudTAK', 'frobnicate']);
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown command');
  });
});
