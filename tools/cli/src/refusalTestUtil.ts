import { CliError, EXIT_USAGE, UsageError } from "./args";

/**
 * Await a command that must REFUSE, and return the refusal text. Asserts the refusal carries
 * exit code 2 (usage / refusal), so a test cannot pass on a thrown crash instead of a refusal.
 */
export async function refusal(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof UsageError && err.exitCode === EXIT_USAGE) return err.message;
    throw err;
  }
  throw new Error("expected the command to refuse, but it succeeded");
}

/** Await a command that must FAIL with a plain error (exit 1); return its message. */
export async function failure(run: Promise<unknown>): Promise<string> {
  try {
    await run;
  } catch (err) {
    if (err instanceof CliError && err.exitCode === 1) return err.message;
    throw err;
  }
  throw new Error("expected the command to fail, but it succeeded");
}
