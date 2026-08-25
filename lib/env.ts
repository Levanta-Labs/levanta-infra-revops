//=============================================================================================================
//Environment access. Every read is reported to the console once per process so a misconfigured deployment is
//diagnosable from the Vercel logs. Secret VALUES are never logged - only whether they are set, how long they
//are, and whether the stored value carried surrounding whitespace.
//=============================================================================================================

const reported = new Set<string>();

function reportOnce(key: string, log: () => void): void {
  if (reported.has(key)) return;
  reported.add(key);
  log();
}

function reportEnv(name: string, raw: string | undefined): void {
  reportOnce(name, () => {
    if (raw === undefined) {
      console.warn(`[env] ${name}: NOT SET on this deployment`);
      return;
    }
    const trimmed = raw.trim();
    if (!trimmed) {
      console.warn(`[env] ${name}: SET BUT BLANK (${raw.length} whitespace char(s))`);
      return;
    }
    const stripped = raw.length - trimmed.length;
    if (stripped > 0) {
      console.warn(
        `[env] ${name}: set, ${trimmed.length} chars, but ${stripped} surrounding whitespace char(s) had to be trimmed - correct the stored value, because senders that sign or compare the raw string will not match`,
      );
      return;
    }
    console.log(`[env] ${name}: set, ${trimmed.length} chars`);
  });
}

/**
 * Prints a non-secret configuration value in full. Only for identifiers whose exact content is needed to spot a
 * mistake and whose exposure is harmless: attribute slugs and service URLs. Never pass a key, token, or secret.
 */
export function reportConfigValue(name: string, value: string): void {
  reportOnce(`${name}:value`, () => {
    console.log(`[config] ${name} = ${JSON.stringify(value)}`);
  });
}

/** Prints only the domain of a configured address, enough to spot a wrong workspace without publishing a mailbox. */
export function reportConfigEmail(name: string, value: string): void {
  reportOnce(`${name}:email`, () => {
    const at = value.lastIndexOf("@");
    const shape = at > 0 ? `…${value.slice(at)}` : "no @ - not an email address";
    console.log(`[config] ${name} = ${shape}`);
  });
}

/** Lets a test suite observe first-read reporting again. */
export function resetEnvReporting(): void {
  reported.clear();
}

export function optionalEnv(name: string): string | null {
  const raw = process.env[name];
  reportEnv(name, raw);
  const value = raw?.trim();
  return value ? value : null;
}

export function requiredEnv(name: string): string {
  const value = optionalEnv(name);
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function requiredCsvEnv(name: string): readonly string[] {
  const values = requiredEnv(name)
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (values.length === 0) {
    throw new Error(`Environment variable ${name} must contain at least one value`);
  }
  reportOnce(`${name}:csv`, () => {
    console.log(`[config] ${name} = ${values.length} value(s): ${JSON.stringify(values)}`);
  });
  return values;
}
