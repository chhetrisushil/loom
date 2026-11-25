# Write your own grant broker

A **grant broker** mints, renews and revokes the grants of [task-scoped authority](user-guide.md#task-scoped-authority-grants-leases-and-renewal-loomworktask-authority-adr-0150) and remembers who holds them. The only broker Loom ships, `InMemoryGrantBroker`, is a reference: a restart loses every grant, claim and revocation. Production needs one that persists. `GrantBroker` is a public interface of `@loomwork/task-authority`, and nothing else in the package depends on the reference class.

| You want | Do |
|---|---|
| Different renewal rules | [Pass a policy](#custom-renewal-rules) to the reference broker |
| Durable state, modest load | [Persist the reference broker](#a-durable-broker): its rules, your storage |
| High load, or an existing authorization service | [Implement the interface](#implementing-the-interface) on your own tables |

All three are [tested](#test-it) and [wired](#wire-it) the same way. The code below is run by `packages/task-authority/src/customBrokerGuide.test.ts`.

## Custom renewal rules

<!-- snippet: policy -->
```ts
const broker = new InMemoryGrantBroker({
  secret,
  policy: (request, { renewals }) =>
    renewals < 3 && (request.spent.email ?? 0) <= 20 ? { leases: { email: 20 } } : false,
  approveCrossLineage: (request) => request.lineages?.length === 1,
});
```

- The policy is **synchronous**; a promise, `null` or a throw denies. `false` denies too.
- A returned number is the new TOTAL ceiling, not extra attempts: spend is never reset.
- `renewals` is the broker's own count. `request.spent` and the justification come from the caller: treat them as untrusted.
- A cross-lineage approval (`directedBy` with `action: "park"`) is refused unless `approveCrossLineage` allows it.

## A durable broker

Each write loads the state, runs the reference rules and stores the result, all under one exclusive lock. The state is the reference broker's five `protected` collections.

<!-- snippet: broker -->
```ts
/** Where the broker's state lives. `update` must be exclusive across every process. */
interface GrantState {
  read(): Promise<string>;
  update<T>(change: (text: string) => Promise<{ text: string; result: T }>): Promise<T>;
}

/** The reference broker, with its state loaded from and dumped to one JSON text. */
class LoadedBroker extends InMemoryGrantBroker {
  load(text: string): this {
    if (text === "") return this; // the migration's empty row: a new broker
    const s = JSON.parse(text);
    for (const [id, r] of s.tasks) this.tasks.set(id, { ...r, children: new Set(r.children) });
    for (const digest of s.revokedDigests) this.revokedDigests.add(digest);
    for (const [id, v] of s.claims) this.claims.set(id, v);
    for (const [id, v] of s.reservations) this.reservations.set(id, v);
    for (const [id, v] of s.carved) this.carved.set(id, v);
    return this;
  }
  dump(): string {
    return JSON.stringify({
      tasks: [...this.tasks].map(([id, r]) => [id, { ...r, children: [...r.children] }]),
      revokedDigests: [...this.revokedDigests],
      claims: [...this.claims],
      reservations: [...this.reservations],
      carved: [...this.carved],
    });
  }
}

class DurableGrantBroker implements GrantBroker {
  constructor(
    private readonly state: GrantState,
    private readonly options: ConstructorParameters<typeof InMemoryGrantBroker>[0]
  ) {}
  private async read<T>(get: (b: LoadedBroker) => Promise<T>): Promise<T> {
    return get(new LoadedBroker(this.options).load(await this.state.read()));
  }
  private write<T>(change: (b: LoadedBroker) => Promise<T>): Promise<T> {
    return this.state.update(async (text) => {
      const b = new LoadedBroker(this.options).load(text);
      const result = await change(b); // a throw rolls back: nothing is stored
      return { text: b.dump(), result };
    });
  }
  current = (taskId: string) => this.read((b) => b.current(taskId));
  revoked = (digest: string) => this.read((b) => b.revoked(digest));
  holder = (taskId: string) => this.read((b) => b.holder(taskId));
  claim = (taskId: string, executionId: string) => this.write((b) => b.claim(taskId, executionId));
  mint = (...a: Parameters<GrantBroker["mint"]>) => this.write((b) => b.mint(...a));
  renew = (...a: Parameters<GrantBroker["renew"]>) => this.write((b) => b.renew(...a));
  revoke = (...a: Parameters<GrantBroker["revoke"]>) => this.write((b) => b.revoke(...a));
  reserve = (...a: Parameters<GrantBroker["reserve"]>) => this.write((b) => b.reserve(...a));
  settleChild = (...a: Parameters<GrantBroker["settleChild"]>) =>
    this.write((b) => b.settleChild(...a));
  settleUnstarted = (...a: Parameters<GrantBroker["settleUnstarted"]>) =>
    this.write((b) => b.settleUnstarted(...a));
  takeReturn = (...a: Parameters<GrantBroker["takeReturn"]>) =>
    this.write((b) => b.takeReturn(...a));
}
```

On Postgres the lock is the row (`FOR UPDATE`). Run `MIGRATION` once, at deploy:

<!-- snippet: postgres -->
```ts
const MIGRATION = `
  CREATE TABLE IF NOT EXISTS grant_broker (id TEXT PRIMARY KEY, state TEXT NOT NULL);
  INSERT INTO grant_broker VALUES ('default', '') ON CONFLICT DO NOTHING;
`;

class PostgresGrantState implements GrantState {
  constructor(
    private readonly pool: Pool,
    private readonly id = "default"
  ) {}
  async read(): Promise<string> {
    const { rows } = await this.pool.query("SELECT state FROM grant_broker WHERE id = $1", [
      this.id,
    ]);
    return this.only(rows);
  }
  async update<T>(change: (text: string) => Promise<{ text: string; result: T }>): Promise<T> {
    const client = await this.pool.connect();
    let broken: Error | undefined;
    try {
      await client.query("BEGIN");
      const { rows } = await client.query(
        "SELECT state FROM grant_broker WHERE id = $1 FOR UPDATE", // the cross-process lock
        [this.id]
      );
      const { text, result } = await change(this.only(rows));
      await client.query("UPDATE grant_broker SET state = $2 WHERE id = $1", [this.id, text]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch((e: Error) => {
        broken = e;
      });
      throw error;
    } finally {
      client.release(broken); // a connection that could not roll back is destroyed
    }
  }
  /** A lost row is an error, never an empty broker: an empty one would forget every claim and revocation. */
  private only(rows: { state: string }[]): string {
    if (rows[0] === undefined) throw new Error(`grant_broker row "${this.id}" is missing`);
    return rows[0].state;
  }
}
```

What to know before you use it:

- **Every write is serialized**, and every call parses the whole state. Revocation answers are cached for 1 s by `taskLeaseMiddleware`, but a busy deployment should move to tables.
- **State only grows.** Nothing here deletes a task. That is the safe default: a task with no record can never be restored, so its run is stranded.
- **Keep the column `TEXT`.** `jsonb` reorders object keys, and the reference `reserve` compares leases as serialized text.
- **Pin the exact `@loomwork/task-authority` version.** `protected` state is not a stable format. Copy the test that compares `dump()` with the collections the class holds: a new one that is not dumped would be lost silently.
- **A lost `COMMIT` acknowledgement is ambiguous.** A retried `mint` is refused as a duplicate (read `current` instead), a retried `renew` at the old epoch is refused as stale, and a retried `takeReturn` pays nothing.

## Implementing the interface

Sign with `signTaskGrant`. Reuse `validateGrantShape`, `widensReadsOrSandbox` (the child subset check), `taskGrantDigest` and `foreignSetHash`. The full contract is the doc comments in `packages/task-authority/src/broker.ts`.

| Method | Must guarantee |
|---|---|
| `current` | The latest grant; `undefined` when unknown or revoked |
| `revoked` | True for the digest of **every past epoch** of a revoked task. Optional in the type, but without it revocation is not checked |
| `claim` | Atomic compare-and-set: the first execution wins, a repeat by it is true, an unknown or revoked task is false |
| `holder` | Side-effect free |
| `mint` | `taskId` never reused. A child narrows its parent (effects, `reads`, `sandbox`, expiry, headroom) and inherits `tenant` / `onBehalfOf` |
| `renew` | Compare-and-set on `epoch`; signs with the current key; keeps identity, `reads` and `sandbox`; a child's ceiling never exceeds its minted one |
| `revoke` | Covers every descendant; idempotent |
| `reserve` | Idempotent; a different lease for a known child is refused |
| `settleChild` | Records a completed child's unused lease once; when no execution holds the parent, refunds its headroom and revokes the child |
| `settleUnstarted` | Atomic with `claim`: a child is started or unstarted, never both |
| `takeReturn` | Pays once, and only to the child's parent |

Two rules are easy to miss. Headroom is the sum of children's **highest** ceilings ever granted: revoking a child or renewing it down releases nothing. And `parentReserved` is compared with a **never-decreasing** total of what was carved from the parent, not with the live sum, or a returned reservation could be spent twice.

## Test it

<!-- illustrative: your broker and store are placeholders -->
```ts
import { checkTaskAuthorityConformance } from "@loomwork/task-authority/conformance";

const report = await checkTaskAuthorityConformance({
  makeBroker: (o) => new MyBroker(freshEmptyState(), o), // honour o.secret, o.now and o.policy
});
expect(report.results.filter((r) => r.status === "failed")).toEqual([]);
```

Give every `makeBroker` call an empty state: the kit reuses task ids. `report.ok` ignores skipped checks, and `laundering.uncovered.a2a` is skipped unless you pass an `a2a` transport. The kit runs in one process and never restarts your broker, so also test a reload, a crash mid-write, and two processes racing one `claim`.

## Wire it

Pass your broker wherever the reference one went: `source` of `taskLeaseMiddleware` and `installTaskAuthority`, `childLeaseEffect({ secret, broker })`, `childGrantMinter`, `answerRenewal`, `answerScheduleApproval`, `schedulePrincipalFor` and `settleScheduledTick`.

- **It is on the resume path.** Restoring a principal calls `current`, `revoked` and `claim`, each bounded by 5 s by default, and a timeout denies (fail closed).
- **It does not hold the only key.** The grant secret is symmetric, so any process that verifies a grant can mint one. A remote broker does not change that: the authorizer's `base` policy is what bounds a verifier.
- **Rotate with a key ring** (`{ current, previous, refOnly }`); see the [user guide](user-guide.md#task-scoped-authority-grants-leases-and-renewal-loomworktask-authority-adr-0150).
