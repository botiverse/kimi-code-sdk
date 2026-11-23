import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const [, , exeArg, expectedVersion] = process.argv;
if (!exeArg || !expectedVersion) {
  console.error('usage: verify-native-kap.mjs <executable-path> <expected-version>');
  process.exit(1);
}

const exePath = resolve(exeArg);
if (!existsSync(exePath)) {
  console.error(`verify-native-kap: executable not found: ${exePath}`);
  process.exit(1);
}

const failures = [];
function expect(label, ok, detail) {
  if (ok) {
    console.log(`  ok   ${label}`);
  } else {
    console.error(`  FAIL ${label}${detail ? `: ${detail}` : ''}`);
    failures.push(label);
  }
}

const tempHome = mkdtempSync(join(tmpdir(), 'kimi-native-kap-'));
const isolatedEnv = {
  ...process.env,
  HOME: tempHome,
  KIMI_CODE_HOME: tempHome,
  USERPROFILE: tempHome,
  APPDATA: join(tempHome, 'appdata'),
  LOCALAPPDATA: join(tempHome, 'localappdata'),
};

let child;
try {
  try {
    const { stdout, stderr } = await execFileAsync(exePath, ['--version'], {
      env: isolatedEnv,
      timeout: 45_000,
    });
    const versionOut = `${stdout}${stderr}`;
    expect(`kimi --version includes ${expectedVersion}`, versionOut.includes(expectedVersion), versionOut.trim());
  } catch (err) {
    expect('kimi --version runs cleanly', false, err instanceof Error ? err.message : String(err));
  }

  try {
    const { stdout, stderr } = await execFileAsync(exePath, ['acp', '--help'], {
      env: isolatedEnv,
      timeout: 45_000,
    });
    const acpHelp = `${stdout}${stderr}`;
    expect('kimi acp --help matches OAR identity pattern', /^\s*Usage:\s+kimi(?:\.exe)?\s+acp\b/imu.test(acpHelp));
  } catch (err) {
    expect('kimi acp --help runs cleanly', false, err instanceof Error ? err.message : String(err));
  }

  child = spawn(exePath, ['web', '--json', '--host', '127.0.0.1', '--port', '0'], {
    env: isolatedEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const boot = await new Promise((resolveBoot, rejectBoot) => {
    let out = '';
    let errText = '';
    const timer = setTimeout(() => {
      rejectBoot(new Error(`timed out waiting for KAP boot line; stdout=${out}; stderr=${errText}`));
    }, 45_000);
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
      for (const line of out.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const parsed = JSON.parse(trimmed);
          if (typeof parsed.origin === 'string' && typeof parsed.token === 'string') {
            clearTimeout(timer);
            resolveBoot(parsed);
            return;
          }
        } catch {
          // ignore non-boot lines
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      errText += chunk.toString();
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      rejectBoot(err);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      rejectBoot(new Error(`kimi web exited early (code=${code}, signal=${signal}); stderr=${errText}`));
    });
  });

  const res = await fetch(`${boot.origin}/api/v1/meta`, {
    headers: { Authorization: `Bearer ${boot.token}` },
    signal: AbortSignal.timeout(10_000),
  });
  expect('KAP /api/v1/meta responds HTTP 200', res.status === 200, `status=${res.status}`);
  const payload = await res.json();
  expect(
    `KAP /meta data.server_version equals ${expectedVersion}`,
    payload?.data?.server_version === expectedVersion,
    String(payload?.data?.server_version),
  );
  const caps = payload?.data?.capabilities ?? {};
  for (const key of [
    'websocket',
    'tasks',
    'session_ephemeral_mcp',
    'session_append_system_prompt',
    'steer_parent_correlation',
  ]) {
    expect(`KAP /meta capabilities.${key} is true`, caps[key] === true, String(caps[key]));
  }
} catch (err) {
  expect('KAP web --json /api/v1/meta probe succeeds', false, err instanceof Error ? err.message : String(err));
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM');
    await new Promise((done) => {
      const forceTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        done();
      }, 3_000);
      child.once('exit', () => {
        clearTimeout(forceTimer);
        done();
      });
    });
  }
  try {
    rmSync(tempHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* ignore cleanup lock on Windows */
  }
}

if (failures.length === 0) {
  console.log(`verify-native-kap: PASS (${exePath}@${expectedVersion})`);
  process.exit(0);
}
console.error(`verify-native-kap: FAIL (${failures.length} failure${failures.length === 1 ? '' : 's'})`);
process.exit(1);
